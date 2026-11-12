import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { pool } from "@workspace/db";
import { AppError } from "./ledger-domain/model";
import { ObjectStorageService } from "./objectStorage";
import { AccountBackupTooLargeError, buildAccountBackupSnapshot } from "./account-backup-format";

const storage = new ObjectStorageService();

export async function exportAccountSnapshot(ownerId: string): Promise<Record<string, unknown>> {
  const [accountResult, ledgerResult, operationResult, imageResult, recognitionResult] = await Promise.all([
    pool.query("SELECT id, display_name, created_at, status FROM accounts WHERE id = $1", [ownerId]),
    pool.query("SELECT owner_id, revision, data, data_raw, last_operation FROM ledgers WHERE owner_id = $1", [ownerId]),
    pool.query("SELECT operation_id, owner_id, idempotency_key, source_event_id, payload_hash, receipt, receipt_raw, created_at FROM operations WHERE owner_id = $1 ORDER BY created_at, id", [ownerId]),
    pool.query("SELECT id, owner_id, sha256, mime_type, byte_size, object_path, uploaded_at FROM images WHERE owner_id = $1 ORDER BY id", [ownerId]),
    pool.query("SELECT id, owner_id, fingerprint, state, result_json, error_code, created_at, finished_at FROM image_recognitions WHERE owner_id = $1 ORDER BY created_at, id", [ownerId]),
  ]);
  if (accountResult.rows.length !== 1 || accountResult.rows[0].status !== "active") {
    throw new AppError(409, "BACKUP_INCOMPLETE", "账号记录不存在或已停用，无法生成完整备份。");
  }

  const images = await Promise.all(imageResult.rows.map(async (row) => {
    const file = await storage.getObjectEntityFile(String(row.object_path));
    const [bytes] = await file.download();
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== String(row.sha256).toLowerCase() || bytes.length !== Number(row.byte_size) ||
      !(await storage.verifyPrivateObject(String(row.object_path), bytes, String(row.mime_type), ownerId))) {
      throw new AppError(503, "BACKUP_INCOMPLETE", "原图文件缺失或哈希不匹配，未生成部分备份。");
    }
    return { ...row, bytes };
  }));

  try {
    return buildAccountBackupSnapshot({
      account: accountResult.rows[0],
      ledger: ledgerResult.rows[0],
      operations: operationResult.rows,
      images,
      recognitions: recognitionResult.rows,
    });
  } catch (error) {
    if (error instanceof AccountBackupTooLargeError) {
      throw new AppError(413, "BACKUP_TOO_LARGE", error.message);
    }
    throw error;
  }
}

function textCellValue(cell: unknown): string {
  if (!cell || typeof cell !== "object" || !("hex" in cell) || typeof cell.hex !== "string") {
    throw new AppError(503, "BACKUP_INCOMPLETE", "快照中的附件清单数据格式无效。");
  }
  return Buffer.from(cell.hex, "hex").toString("utf8");
}

function fileExtension(mimeType: string): string {
  const extensions: Record<string, string> = {
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/pdf": ".pdf",
    "text/html": ".html",
    "text/markdown": ".md",
    "text/x-markdown": ".md",
    "text/plain": ".txt",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
  };
  const extension = extensions[mimeType];
  if (!extension) throw new AppError(503, "BACKUP_INCOMPLETE", "备份中包含不支持的文件类型。");
  return extension;
}

export async function exportAccountBackupArchive(ownerId: string): Promise<Buffer> {
  const snapshot = await exportAccountSnapshot(ownerId);
  const genericFiles = await pool.query(
    `SELECT id, source_library_id, source_file_id, source_version, source_version_type,
             library_ref, version_id, file_name, mime_type, byte_size, sha256, object_path
      FROM account_files WHERE owner_id = $1 ORDER BY library_ref, version_id NULLS LAST`,
    [ownerId],
  );
  const zipEntries: Record<string, Uint8Array> = {
    "account-snapshot.json": strToU8(JSON.stringify(snapshot, null, 2)),
  };
  const manifest = {
    format: "project-ledger-complete-file-manifest-v1",
    images: [] as Array<Record<string, unknown>>,
    files: [] as Array<Record<string, unknown>>,
  };

  const snapshotTables = snapshot.tables as Record<string, { rows: unknown[][] }>;
  const imageRows = snapshotTables.images?.rows ?? [];
  for (const row of imageRows) {
    const id = textCellValue(row[0]);
    const mimeType = textCellValue(row[3]);
    const sha256 = textCellValue(row[2]).toLowerCase();
    const byteSize = Number((row[4] as { value?: string })?.value);
    const bytesCell = row[6] as { hex?: string } | undefined;
    if (!bytesCell?.hex) throw new AppError(503, "BACKUP_INCOMPLETE", "备份中缺少图片原始字节。");
    const bytes = Buffer.from(bytesCell.hex, "hex");
    const fileName = `${id}${fileExtension(mimeType)}`;
    if (bytes.length !== byteSize || createHash("sha256").update(bytes).digest("hex") !== sha256) {
      throw new AppError(503, "BACKUP_INCOMPLETE", "图片字节、大小或 SHA-256 核验失败。");
    }
    manifest.images.push({ image_id: id, file_name: fileName, mime_type: mimeType, byte_size: byteSize, sha256 });
    zipEntries[`images/${id}/${fileName}`] = bytes;
  }

  let totalBytes = Object.values(zipEntries).reduce((sum, bytes) => sum + bytes.byteLength, 0);
  for (const row of genericFiles.rows as Array<Record<string, unknown>>) {
    const fileName = String(row.file_name);
    if (!fileName || fileName.length > 300 || fileName === "." || fileName === ".." ||
      fileName.includes("/") || fileName.includes("\\") || /[\u0000-\u001f\u007f]/.test(fileName)) {
      throw new AppError(503, "BACKUP_INCOMPLETE", "Library 文件名不安全，未生成部分备份。");
    }
    const objectPath = String(row.object_path);
    let owned: Awaited<ReturnType<ObjectStorageService["getOwnedPrivateAccountFile"]>>;
    try {
      owned = await storage.getOwnedPrivateAccountFile(objectPath, ownerId);
    } catch {
      throw new AppError(503, "BACKUP_INCOMPLETE", "私有 Library 附件不存在或账号归属核验失败。");
    }
    const [bytes] = await owned.file.download();
    const mimeType = String(row.mime_type);
    const sha256 = String(row.sha256).toLowerCase();
    const byteSize = Number(row.byte_size);
    if (owned.metadata.contentType !== mimeType || Number(owned.metadata.size) !== byteSize ||
      bytes.length !== byteSize || createHash("sha256").update(bytes).digest("hex") !== sha256) {
      throw new AppError(503, "BACKUP_INCOMPLETE", "Library 附件字节、大小或 SHA-256 核验失败。");
    }
    const id = String(row.id);
    zipEntries[`files/${id}/${fileName}`] = bytes;
    manifest.files.push({
      library_id: String(row.source_library_id),
      file_id: String(row.source_file_id),
      version: row.source_version_type === "number" ? Number(row.source_version) : String(row.source_version),
      library_ref: String(row.library_ref),
      version_id: row.version_id === null ? null : String(row.version_id),
      file_name: fileName,
      mime_type: mimeType,
      byte_size: byteSize,
      sha256,
    });
    totalBytes += bytes.byteLength;
    if (totalBytes > 128_000_000) throw new AppError(413, "BACKUP_TOO_LARGE", "完整备份超过 128 MB 上限，未返回部分内容。");
  }
  zipEntries["library-files-manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
  const archive = Buffer.from(zipSync(zipEntries, { level: 0 }));
  if (archive.length > 128_000_000) throw new AppError(413, "BACKUP_TOO_LARGE", "完整备份超过 128 MB 上限，未返回部分内容。");
  return archive;
}
