import { createHash } from "node:crypto";
import { pool } from "@workspace/db";
import {
  AppError,
  applyChanges,
  type Change,
  type Ledger,
  type Submit,
} from "./ledger-domain/model";

export type LedgerRow = {
  owner_id: string;
  revision: number;
  data: Ledger;
  last_operation: string;
};

export type VerifiedImage = {
  id: string;
  sha256: string;
  mimeType: string;
  byteSize: number;
  objectPath: string;
};

export function emptyLedger(): Ledger {
  return {
    projects: [],
    tasks: [],
    documents: [],
    pending: [],
    settings: {
      timezone: "Asia/Shanghai",
      intervalHours: 2,
      workStart: "09:00",
      workEnd: "19:00",
      enabled: false,
    },
    reminderLog: [],
  };
}

export async function readLedger(userId: string): Promise<LedgerRow | null> {
  const result = await pool.query<LedgerRow>(
    "SELECT owner_id, revision, data, last_operation FROM ledgers WHERE owner_id = $1",
    [userId],
  );
  return result.rows[0] ?? null;
}

export async function initializeLedger(userId: string): Promise<LedgerRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO accounts (id, display_name)
       VALUES ($1, '本人')
       ON CONFLICT (id) DO NOTHING`,
      [userId],
    );
    await client.query(
      `INSERT INTO ledgers (owner_id, revision, data, last_operation)
       VALUES ($1, 0, $2::jsonb, '')
       ON CONFLICT (owner_id) DO NOTHING`,
      [userId, JSON.stringify(emptyLedger())],
    );
    const result = await client.query<LedgerRow>(
      "SELECT owner_id, revision, data, last_operation FROM ledgers WHERE owner_id = $1",
      [userId],
    );
    await client.query("COMMIT");
    const ledger = result.rows[0];
    if (!ledger) throw new Error("Ledger initialization returned no row.");
    return ledger;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function commitOperation(
  userId: string,
  request: Submit,
  verifiedImage?: VerifiedImage,
): Promise<Record<string, unknown>> {
  validateSubmit(request);
  const client = await pool.connect();
  const payloadHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");

  try {
    await client.query("BEGIN");
    const existing = await client.query<{ payload_hash: string; receipt: Record<string, unknown> }>(
      `SELECT payload_hash, receipt FROM operations
       WHERE owner_id = $1 AND (operation_id = $2 OR idempotency_key = $3)
       LIMIT 1`,
      [userId, request.operation_id, request.idempotency_key],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].payload_hash !== payloadHash) {
        throw new AppError(409, "IDEMPOTENCY_CONFLICT", "该操作编号已用于另一份请求。");
      }
      await client.query("COMMIT");
      return { ...existing.rows[0].receipt, duplicate: true };
    }

    const ledgerResult = await client.query<LedgerRow>(
      `SELECT owner_id, revision, data, last_operation
       FROM ledgers WHERE owner_id = $1 FOR UPDATE`,
      [userId],
    );
    const ledger = ledgerResult.rows[0];
    if (!ledger) throw new AppError(409, "NOT_INITIALIZED", "请先创建个人空间。");
    if (request.base_version !== ledger.revision) {
      throw new AppError(409, "REVISION_CONFLICT", "账本已有更新，请重新读取并生成预览。", {
        current_revision: ledger.revision,
      });
    }

    if (verifiedImage) {
      await client.query(
        `INSERT INTO images (id, owner_id, sha256, mime_type, byte_size, object_path)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (owner_id, id) DO NOTHING`,
        [
          verifiedImage.id,
          userId,
          verifiedImage.sha256,
          verifiedImage.mimeType,
          verifiedImage.byteSize,
          verifiedImage.objectPath,
        ],
      );
    }
    const attachmentIds = new Set<string>();
    for (const change of request.changes) {
      const ids = change.values.attachment_ids;
      if (Array.isArray(ids)) {
        for (const id of ids) if (typeof id === "string") attachmentIds.add(id);
      }
    }
    if (attachmentIds.size) {
      const ownedImages = await client.query<{ id: string }>(
        "SELECT id FROM images WHERE owner_id = $1 AND id = ANY($2::text[])",
        [userId, [...attachmentIds]],
      );
      const ownedIds = new Set(ownedImages.rows.map((row) => row.id));
      if ([...attachmentIds].some((id) => !ownedIds.has(id))) {
        throw new AppError(403, "IMAGE_ACCESS", "图片不是当前账号上传的私有图片。");
      }
    }

    const now = new Date().toISOString();
    const applied = applyChanges(ledger.data, request.changes, now, request.occurred_at);
    const nextRevision = applied.effective.length ? ledger.revision + 1 : ledger.revision;
    const receipt: Record<string, unknown> = {
      state: "verified",
      operation_id: request.operation_id,
      result_version: nextRevision,
      changes: applied.effective,
      before: ledger.data,
      after: applied.data,
      raw_text: request.raw_text,
      occurred_at: request.occurred_at,
      source_event_id: request.source_event_id,
      created_at: now,
      ...(request.undo_of ? { undo_of: request.undo_of } : {}),
    };

    if (applied.effective.length) {
      await client.query(
        `UPDATE ledgers
         SET revision = $2, data = $3::jsonb, data_raw = NULL, last_operation = $4, updated_at = NOW()
         WHERE owner_id = $1`,
        [userId, nextRevision, JSON.stringify(applied.data), request.operation_id],
      );
    }
    await client.query(
      `INSERT INTO operations
       (owner_id, operation_id, idempotency_key, source_event_id, payload_hash, receipt)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        userId,
        request.operation_id,
        request.idempotency_key,
        request.source_event_id,
        payloadHash,
        JSON.stringify(receipt),
      ],
    );
    if (verifiedImage) {
      await client.query(
        "DELETE FROM pending_uploads WHERE owner_id = $1 AND object_path = $2",
        [userId, verifiedImage.objectPath],
      );
    }
    await client.query("COMMIT");
    return receipt;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof AppError) throw error;
    if (isUniqueViolation(error)) {
      throw new AppError(409, "IDEMPOTENCY_CONFLICT", "该请求编号已处理，请查询原操作回执。");
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function listOperations(userId: string, limit = 50): Promise<Record<string, unknown>[]> {
  const result = await pool.query<{ receipt: Record<string, unknown> }>(
    `SELECT receipt FROM operations
     WHERE owner_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, Math.min(Math.max(limit, 1), 100)],
  );
  return result.rows.map((row) => row.receipt);
}

export async function findOperation(
  userId: string,
  operationId: string,
): Promise<Record<string, unknown> | null> {
  const result = await pool.query<{ receipt: Record<string, unknown> }>(
    "SELECT receipt FROM operations WHERE owner_id = $1 AND operation_id = $2",
    [userId, operationId],
  );
  return result.rows[0]?.receipt ?? null;
}

export async function undoOperation(
  userId: string,
  operationId: string,
  baseVersion: number,
  idempotencyKey: string,
): Promise<Record<string, unknown>> {
  const client = await pool.connect();
  const undoId = `undo-${idempotencyKey}`;
  const requestHash = createHash("sha256")
    .update(JSON.stringify({ operationId, baseVersion, idempotencyKey }))
    .digest("hex");

  try {
    await client.query("BEGIN");
    const duplicate = await client.query<{ payload_hash: string; receipt: Record<string, unknown> }>(
      "SELECT payload_hash, receipt FROM operations WHERE owner_id = $1 AND operation_id = $2",
      [userId, undoId],
    );
    if (duplicate.rows[0]) {
      if (duplicate.rows[0].payload_hash !== requestHash) {
        throw new AppError(409, "IDEMPOTENCY_CONFLICT", "撤销编号已用于其他请求。");
      }
      await client.query("COMMIT");
      return { ...duplicate.rows[0].receipt, duplicate: true };
    }

    const ledgerResult = await client.query<LedgerRow>(
      "SELECT owner_id, revision, data, last_operation FROM ledgers WHERE owner_id = $1 FOR UPDATE",
      [userId],
    );
    const ledger = ledgerResult.rows[0];
    if (!ledger) throw new AppError(409, "NOT_INITIALIZED", "个人空间尚未创建。");
    if (ledger.revision !== baseVersion) {
      throw new AppError(409, "REVISION_CONFLICT", "账本已有更新，不能按旧版本撤销。");
    }
    const targetResult = await client.query<{ receipt: Record<string, unknown> }>(
      "SELECT receipt FROM operations WHERE owner_id = $1 AND operation_id = $2",
      [userId, operationId],
    );
    const target = targetResult.rows[0]?.receipt;
    if (!target || target.result_version !== ledger.revision || target.after == null || target.before == null) {
      throw new AppError(409, "UNDO_CONFLICT", "只能撤销最近一次已验证的操作。");
    }

    const now = new Date().toISOString();
    const after = target.before as Ledger;
    const receipt: Record<string, unknown> = {
      state: "verified",
      operation_id: undoId,
      result_version: ledger.revision + 1,
      changes: [{ type: "restore", id: operationId, values: {} }],
      before: ledger.data,
      after,
      raw_text: `撤销操作 ${operationId}`,
      occurred_at: now,
      source_event_id: undoId,
      created_at: now,
      undo_of: operationId,
    };
    await client.query(
      `UPDATE ledgers SET revision = $2, data = $3::jsonb, data_raw = NULL, last_operation = $4, updated_at = NOW()
       WHERE owner_id = $1`,
      [userId, ledger.revision + 1, JSON.stringify(after), undoId],
    );
    await client.query(
      `INSERT INTO operations
       (owner_id, operation_id, idempotency_key, source_event_id, payload_hash, receipt)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [userId, undoId, idempotencyKey, undoId, requestHash, JSON.stringify(receipt)],
    );
    await client.query("COMMIT");
    return receipt;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof AppError) throw error;
    if (isUniqueViolation(error)) {
      throw new AppError(409, "IDEMPOTENCY_CONFLICT", "撤销请求已处理，请查询原操作回执。");
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function exportAccount(userId: string): Promise<Record<string, unknown>> {
  const [ledger, operations, imageRows] = await Promise.all([
    readLedger(userId),
    listOperations(userId, 100),
    pool.query(
      `SELECT id, sha256, mime_type, byte_size, object_path, uploaded_at
       FROM images WHERE owner_id = $1 ORDER BY uploaded_at DESC`,
      [userId],
    ),
  ]);
  return {
    initialized: !!ledger,
    revision: ledger?.revision ?? 0,
    data: ledger?.data ?? null,
    operations,
    images: imageRows.rows,
    exported_at: new Date().toISOString(),
  };
}

function validateSubmit(value: Submit): void {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.operation_id !== "string" ||
    value.operation_id.length < 1 ||
    value.operation_id.length > 150 ||
    typeof value.idempotency_key !== "string" ||
    value.idempotency_key.length < 1 ||
    value.idempotency_key.length > 200 ||
    typeof value.source_event_id !== "string" ||
    value.source_event_id.length < 1 ||
    value.source_event_id.length > 200 ||
    !Number.isInteger(value.base_version) ||
    value.base_version < 0 ||
    typeof value.occurred_at !== "string" ||
    !Number.isFinite(Date.parse(value.occurred_at)) ||
    typeof value.raw_text !== "string" ||
    value.raw_text.length > 5000 ||
    !Array.isArray(value.changes) ||
    value.changes.length > 100 ||
    value.confirmed !== true
  ) {
    throw new AppError(400, "INVALID_OPERATION", "操作请求格式无效或尚未确认。");
  }
}

function isUniqueViolation(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "23505";
}
