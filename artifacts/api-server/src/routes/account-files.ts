import { createHash } from "node:crypto";
import { Router, type IRouter, type Request, type RequestHandler, type Response } from "express";
import { pool } from "@workspace/db";
import { requireUser, verifyAccountScope, verifySameOrigin } from "../lib/auth";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";

const router: IRouter = Router();
const storage = new ObjectStorageService();

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

function safeDownloadName(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, "_").replace(/[\\"]/g, "_").slice(0, 180) || "private-file";
}

function encodedFileName(name: string): string {
  return encodeURIComponent(name).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function downloadPath(libraryRef: string, versionId: string | null): string {
  const encodedRef = encodeURIComponent(libraryRef);
  return versionId === null
    ? `/api/account-files/reference/${encodedRef}/download`
    : `/api/account-files/reference/${encodedRef}/${encodeURIComponent(versionId)}/download`;
}

async function sendPrivateFile(userId: string, row: Record<string, unknown>, res: Response): Promise<void> {
  try {
    const { file, metadata } = await storage.getOwnedPrivateAccountFile(String(row.object_path), userId);
    const [bytes] = await file.download();
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (metadata.contentType !== row.mime_type || Number(metadata.size) !== Number(row.byte_size) ||
      bytes.length !== Number(row.byte_size) || actualHash !== String(row.sha256).toLowerCase()) {
      res.status(503).json({ error: "FILE_VERIFY_FAILED", message: "私有附件完整性校验失败，未返回文件。" });
      return;
    }
    const name = String(row.file_name);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Download-Options", "noopen");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(bytes.length));
    res.setHeader("Content-Disposition", `attachment; filename="${safeDownloadName(name)}"; filename*=UTF-8''${encodedFileName(name)}`);
    res.status(200).send(bytes);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "FILE_NOT_FOUND", message: "该私有附件不存在或不属于当前账号。" });
      return;
    }
    res.status(503).json({ error: "FILE_UNAVAILABLE", message: "私有附件暂时无法读取。" });
  }
}

router.get("/account-files/resolve", authAndScope, async (req, res): Promise<void> => {
  const userId = res.locals.userId as string;
  const libraryRef = typeof req.query.library_ref === "string" ? req.query.library_ref : "";
  const versionId = typeof req.query.version_id === "string" ? req.query.version_id : undefined;
  if (!/^libfile_[A-Za-z0-9]+$/.test(libraryRef) || (versionId !== undefined && (!versionId || versionId.length > 255))) {
    res.status(400).json({ error: "INVALID_REFERENCE", message: "Library 引用格式无效。" });
    return;
  }
  const result = await pool.query(
    `SELECT source_library_id, source_file_id, source_version, source_version_type,
            library_ref, version_id, file_name, mime_type, byte_size, sha256
     FROM account_files
     WHERE owner_id = $1 AND library_ref = $2 AND ($3::text IS NULL OR version_id = $3)
     ORDER BY version_id NULLS LAST`,
    [userId, libraryRef, versionId ?? null],
  );
  if (!result.rows.length) {
    res.status(404).json({ error: "FILE_NOT_FOUND", message: "该私有引用未导入到当前账号。" });
    return;
  }
  if (!versionId && result.rows.length > 1) {
    res.status(409).json({
      error: "VERSION_REQUIRED",
      message: "此引用有多个版本，请指定版本编号。",
      versions: result.rows.map((row) => ({ version_id: row.version_id, source_version: row.source_version })),
    });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.json({
    files: result.rows.map((row) => ({
      ...row,
      download_path: downloadPath(String(row.library_ref), row.version_id === null ? null : String(row.version_id)),
    })),
  });
});

router.get("/account-files/reference/:libraryRef/:versionId/download", authAndScope, async (req, res): Promise<void> => {
  const userId = res.locals.userId as string;
  const libraryRef = Array.isArray(req.params.libraryRef) ? req.params.libraryRef[0] : req.params.libraryRef;
  const versionId = Array.isArray(req.params.versionId) ? req.params.versionId[0] : req.params.versionId;
  if (!/^libfile_[A-Za-z0-9]+$/.test(libraryRef) || !versionId || versionId.length > 255) {
    res.status(400).json({ error: "INVALID_REFERENCE", message: "Library 引用或版本格式无效。" });
    return;
  }
  const result = await pool.query(
    `SELECT file_name, mime_type, byte_size, sha256, object_path
     FROM account_files WHERE owner_id = $1 AND library_ref = $2 AND version_id = $3`,
    [userId, libraryRef, versionId],
  );
  const row = result.rows[0];
  if (!row) {
    res.status(404).json({ error: "FILE_NOT_FOUND", message: "该私有引用未导入到当前账号。" });
    return;
  }
  await sendPrivateFile(userId, row, res);
});

router.get("/account-files/reference/:libraryRef/download", authAndScope, async (req, res): Promise<void> => {
  const userId = res.locals.userId as string;
  const libraryRef = Array.isArray(req.params.libraryRef) ? req.params.libraryRef[0] : req.params.libraryRef;
  if (!/^libfile_[A-Za-z0-9]+$/.test(libraryRef)) {
    res.status(400).json({ error: "INVALID_REFERENCE", message: "Library 引用格式无效。" });
    return;
  }
  const result = await pool.query(
    `SELECT version_id, file_name, mime_type, byte_size, sha256, object_path
     FROM account_files WHERE owner_id = $1 AND library_ref = $2`,
    [userId, libraryRef],
  );
  if (!result.rows.length) {
    res.status(404).json({ error: "FILE_NOT_FOUND", message: "该私有引用未导入到当前账号。" });
    return;
  }
  if (result.rows.length !== 1) {
    res.status(409).json({ error: "VERSION_REQUIRED", message: "此裸 Library 引用对应多个文件版本，不能唯一解析。" });
    return;
  }
  await sendPrivateFile(userId, result.rows[0], res);
});

export default router;
