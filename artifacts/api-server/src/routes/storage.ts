import { Readable } from "node:stream";
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from "@workspace/api-zod";
import { Router, type IRouter, type RequestHandler } from "express";
import { pool } from "@workspace/db";
import { ObjectPermission } from "../lib/objectAcl";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";
import { AppError } from "../lib/ledger-domain/model";
import {
  ensureAccount,
  requireUser,
  verifyAccountScope,
  verifySameOrigin,
} from "../lib/auth";

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();

const getUser: RequestHandler = async (req, res, next) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  res.locals.userId = userId;
  try {
    await ensureAccount(userId);
    next();
  } catch (error) {
    next(error);
  }
};

const scopedUser: RequestHandler = (req, res, next) => {
  if (!verifySameOrigin(req)) {
    res.status(403).json({ error: "ORIGIN_REJECTED", message: "请求来源无效。" });
    return;
  }
  if (!verifyAccountScope(req, res, res.locals.userId as string)) return;
  next();
};

router.post(
  "/storage/uploads/request-url",
  getUser,
  scopedUser,
  async (req, res, next) => {
    try {
      const parsed = RequestUploadUrlBody.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, "INVALID_UPLOAD", "图片名称、大小或格式无效。");
      }
      const { name, size, contentType } = parsed.data;
      const uploadURL = await objectStorage.getObjectEntityUploadURL();
      const objectPath = objectStorage.normalizeObjectEntityPath(uploadURL);
      if (!objectPath.startsWith("/objects/")) {
        throw new Error("Generated object path is outside private storage.");
      }
      await pool.query(
        `INSERT INTO pending_uploads (owner_id, object_path, file_name, byte_size, mime_type)
         VALUES ($1, $2, $3, $4, $5)`,
        [res.locals.userId, objectPath, name, size, contentType],
      );
      res.setHeader("Cache-Control", "no-store");
      res.json(
        RequestUploadUrlResponse.parse({
          uploadURL,
          objectPath,
          metadata: { name, size, contentType },
        }),
      );
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/storage/public-objects/*filePath",
  async (req, res, next) => {
    try {
      const raw = req.params.filePath;
      const filePath = Array.isArray(raw) ? raw.join("/") : raw;
      const objectFile = await objectStorage.searchPublicObject(filePath);
      if (!objectFile) {
        res.status(404).json({ error: "OBJECT_NOT_FOUND", message: "文件不存在。" });
        return;
      }
      await pipeObject(await objectStorage.downloadObject(objectFile), res);
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/storage/objects/*path",
  getUser,
  async (req, res, next) => {
    try {
      const userId = res.locals.userId as string;
      const raw = req.params.path;
      const objectPath = `/objects/${Array.isArray(raw) ? raw.join("/") : raw}`;
      const result = await pool.query<{ object_path: string }>(
        "SELECT object_path FROM images WHERE owner_id = $1 AND object_path = $2",
        [userId, objectPath],
      );
      if (!result.rows[0]) {
        res.status(404).json({ error: "OBJECT_NOT_FOUND", message: "文件不存在。" });
        return;
      }
      const objectFile = await objectStorage.getObjectEntityFile(objectPath);
      const allowed = await objectStorage.canAccessObjectEntity({
        userId,
        objectFile,
        requestedPermission: ObjectPermission.READ,
      });
      if (!allowed) {
        res.status(403).json({ error: "OBJECT_ACCESS", message: "无权读取此文件。" });
        return;
      }
      await pipeObject(await objectStorage.downloadObject(objectFile, 0), res, true);
    } catch (error) {
      next(error);
    }
  },
);

router.use((error: unknown, _req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1], next: Parameters<RequestHandler>[2]) => {
  if (res.headersSent) return next(error);
  if (error instanceof AppError) {
    res.status(error.status).json({ error: error.code, message: error.message });
    return;
  }
  if (error instanceof ObjectNotFoundError) {
    res.status(404).json({ error: "OBJECT_NOT_FOUND", message: "文件不存在。" });
    return;
  }
  res.status(500).json({ error: "STORAGE_ERROR", message: "私有文件请求暂时无法完成。" });
});

async function pipeObject(
  response: Response,
  res: Parameters<RequestHandler>[1],
  privateObject = false,
): Promise<void> {
  res.status(response.status);
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (privateObject) {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Disposition", "inline");
  }
  if (response.body) {
    Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res);
  } else {
    res.end();
  }
}

export default router;
