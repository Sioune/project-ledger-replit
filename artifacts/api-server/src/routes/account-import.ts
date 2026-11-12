import { randomUUID } from "node:crypto";
import { Router, type IRouter, type Request, type RequestHandler } from "express";
import multer from "multer";
import { pool } from "@workspace/db";
import { AccountImportError, commitAccountImport, getDestinationConflicts, parseAccountSnapshot, type PreparedAccountImport } from "../lib/account-import-core";
import { receiveBackup, type StoredImportFile } from "../lib/account-import-upload";
import { ObjectStorageService } from "../lib/objectStorage";
import { requireUser, verifyAccountScope, verifySameOrigin } from "../lib/auth";

const router: IRouter = Router();
const storage = new ObjectStorageService();
const STAGE_TTL_MS = 10 * 60 * 1000;

type ImportStage = {
  ownerId: string;
  prepared: PreparedAccountImport;
  expiresAt: number;
  committing: boolean;
};

const stages = new Map<string, ImportStage>();

const authAndScope: RequestHandler = (req, res, next) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  if (!verifySameOrigin(req)) {
    res.status(403).json({ error: "ORIGIN_REJECTED", message: "请求来源无效。" });
    return;
  }
  if (!verifyAccountScope(req, res, userId)) return;
  res.locals.userId = userId;
  next();
};

function purgeExpiredStages(): void {
  const now = Date.now();
  for (const [id, stage] of stages) {
    if (stage.expiresAt <= now && !stage.committing) stages.delete(id);
  }
}

function filesFor(req: Request, key: string): StoredImportFile[] {
  const files = req.files as Record<string, StoredImportFile[]> | undefined;
  return files?.[key] ?? [];
}

function sendImportError(res: Parameters<RequestHandler>[1], error: unknown): void {
  if (error instanceof AccountImportError) {
    res.status(error.status).json({ error: error.code, message: error.message, ...error.details });
    return;
  }
  if (error instanceof multer.MulterError) {
    res.status(413).json({ error: "UPLOAD_LIMIT", message: "备份文件超过接收上限，未写入数据。" });
    return;
  }
  res.status(500).json({ error: "IMPORT_FAILED", message: "迁入未完成，已尝试清理本次临时附件。" });
}

router.post("/account-import/preview", authAndScope, receiveBackup, async (req, res): Promise<void> => {
  try {
    purgeExpiredStages();
    if (stages.size >= 1) {
      res.status(429).json({ error: "TOO_MANY_STAGES", message: "当前已有多个待确认的备份，请关闭旧预览后重试。" });
      return;
    }
    const snapshotFile = filesFor(req, "snapshot")[0];
    if (!snapshotFile || !/\.json$/i.test(snapshotFile.originalname)) {
      res.status(400).json({ error: "SNAPSHOT_REQUIRED", message: "请选择完整账号快照 JSON 文件。" });
      return;
    }
    const manifestFile = filesFor(req, "manifest")[0];
    const attachmentFiles = filesFor(req, "attachments");
    const prepared = parseAccountSnapshot(
      snapshotFile.buffer.toString("utf8"),
      manifestFile ? { originalname: manifestFile.originalname, buffer: manifestFile.buffer } : undefined,
      attachmentFiles.map(({ originalname, buffer }) => ({ originalname, buffer })),
    );
    const ownerId = res.locals.userId as string;
    const conflicts = await getDestinationConflicts(pool, ownerId);
    const ledgerData = prepared.ledger?.data;
    const textPreview = (value: unknown): string => typeof value === "string" ? value.slice(0, 140) : "";
    const projects = Array.isArray(ledgerData?.projects) ? ledgerData.projects : [];
    const tasks = Array.isArray(ledgerData?.tasks) ? ledgerData.tasks : [];
    const recentOperations = [...prepared.operations]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, 5)
      .map((operation) => ({
        operation_id: operation.operationId,
        created_at: operation.createdAt,
        state: textPreview(operation.receipt.state) || "已保留回执",
      }));
    const result: Record<string, unknown> = {
      digest: prepared.digest,
      counts: prepared.rowCounts,
      total_rows: Object.values(prepared.rowCounts).reduce((sum, count) => sum + count, 0),
      source_account_name: prepared.displayName.slice(0, 80),
      attachment_count: prepared.images.length,
      attachment_bytes: prepared.images.reduce((sum, image) => sum + image.byteSize, 0),
      attachments: prepared.images.map(({ id, sha256, mimeType, byteSize, fileName }) => ({ id, sha256, mime_type: mimeType, byte_size: byteSize, file_name: fileName ?? null })),
      library_file_count: prepared.files.length,
      library_file_bytes: prepared.files.reduce((sum, file) => sum + file.byteSize, 0),
      library_files: prepared.files.map((file) => ({
        library_id: file.libraryId,
        file_id: file.sourceFileId,
        version: file.sourceVersionType === "number" ? Number(file.sourceVersion) : file.sourceVersion,
        library_ref: file.libraryRef,
        version_id: file.versionId,
        file_name: file.fileName,
        mime_type: file.mimeType,
        byte_size: file.byteSize,
        sha256: file.sha256,
      })),
      file_validation: prepared.fileValidation,
      source_account_masked: `••••${prepared.sourceAccountId.slice(-4)}`,
      target_binding: "将绑定到当前已登录账号",
      data_preview: {
        projects: projects.slice(0, 8).map((project) => isPreviewRecord(project) ? textPreview(project.name || project.title) : ""),
        tasks: tasks.slice(0, 8).map((task) => isPreviewRecord(task) ? ({
          title: textPreview(task.title),
          status: textPreview(task.status),
        }) : null).filter(Boolean),
        recent_operations: recentOperations,
        truncated: projects.length > 8 || tasks.length > 8 || prepared.operations.length > 5,
      },
      captured_at: prepared.capturedAt,
      snapshot_bytes: prepared.snapshotBytes,
      conflicts,
      expires_in_seconds: Math.floor(STAGE_TTL_MS / 1000),
    };
    if (!conflicts.length && prepared.fileValidation.can_import) {
      const stageId = randomUUID();
      stages.set(stageId, { ownerId, prepared, expiresAt: Date.now() + STAGE_TTL_MS, committing: false });
      result.stage_id = stageId;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  } catch (error) {
    sendImportError(res, error);
  }
});

function isPreviewRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

router.post("/account-import/commit", authAndScope, async (req, res): Promise<void> => {
  const ownerId = res.locals.userId as string;
  const body = req.body as Record<string, unknown>;
  if (body?.confirm !== true || typeof body.stage_id !== "string" || typeof body.digest !== "string" || !/^[a-f0-9]{64}$/.test(body.digest)) {
    res.status(400).json({ error: "CONFIRMATION_REQUIRED", message: "请先完成预览并明确确认迁入。" });
    return;
  }
  const stage = stages.get(body.stage_id);
  if (!stage || stage.expiresAt <= Date.now() || stage.ownerId !== ownerId || stage.prepared.digest !== body.digest) {
    stages.delete(body.stage_id);
    res.status(409).json({ error: "STAGE_EXPIRED", message: "备份预览已过期或账号不匹配，请重新选择并核验文件。" });
    return;
  }
  if (stage.committing) {
    res.status(409).json({ error: "IMPORT_IN_PROGRESS", message: "这份备份已在处理中，请勿重复提交。" });
    return;
  }
  stage.committing = true;
  try {
    const result = await commitAccountImport(pool, storage, ownerId, stage.prepared);
    stages.delete(body.stage_id);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ...result, import_id: stage.prepared.importId, digest: stage.prepared.digest });
  } catch (error) {
    stage.committing = false;
    sendImportError(res, error);
  }
});

router.post("/account-import/cancel", authAndScope, (req, res): void => {
  const stageId = (req.body as Record<string, unknown> | undefined)?.stage_id;
  if (typeof stageId === "string") {
    const stage = stages.get(stageId);
    if (stage?.ownerId === res.locals.userId) stages.delete(stageId);
  }
  res.status(204).end();
});

router.use((error: unknown, _req: Request, res: Parameters<RequestHandler>[1], next: Parameters<RequestHandler>[2]) => {
  if (res.headersSent) { next(error); return; }
  sendImportError(res, error);
});

export default router;
