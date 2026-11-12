import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { Router, type IRouter, type RequestHandler } from "express";
import { pool } from "@workspace/db";
import {
  AppError,
  type Submit,
} from "../lib/ledger-domain/model";
import { buildIntakePreview, type IntakePreviewInput } from "../lib/ledger-domain/intake";
import type { IntakeImage } from "../lib/ledger-domain/intake-types";
import { ObjectPermission } from "../lib/objectAcl";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";
import {
  commitOperation,
  findOperation,
  readLedger,
  type VerifiedImage,
} from "../lib/ledger-store";
import {
  ensureAccount,
  getAccountScope,
  requireUser,
  verifyAccountScope,
  verifySameOrigin,
} from "../lib/auth";

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();
const MAX_IMAGE_BYTES = 1_500_000;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

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

const asyncRoute = (handler: RequestHandler): RequestHandler => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

router.get(
  "/intake/capabilities",
  getUser,
  asyncRoute(async (_req, res) => {
    const userId = res.locals.userId as string;
    res.setHeader("Cache-Control", "no-store");
    res.json({
      vision: {
        configured: false,
        enabled: false,
        provider: "none",
        model: "",
        pricing_text: "此版本不调用外部视觉模型，也不会产生识图 API 费用。",
        retention_text: "只有在确认保存事项时，原图才会上传到本人私有存储。",
        max_daily_requests: 0,
      },
      max_image_bytes: MAX_IMAGE_BYTES,
      allowed_types: IMAGE_TYPES,
      storage_text: "图片先保存在本人浏览器草稿；确认保存时上传到私有存储，并与本人的事项关联。",
      draft_scope: getAccountScope(userId),
    });
  }),
);

router.post(
  "/intake/preview",
  getUser,
  scopedUser,
  asyncRoute(async (req, res) => {
    const ledger = await readLedger(res.locals.userId as string);
    if (!ledger) throw new AppError(409, "NOT_INITIALIZED", "请先创建个人空间。");
    const body = req.body as Record<string, unknown>;
    const input = parseJsonField<IntakePreviewInput>(body.draft_json, "draft_json");
    const imageValue = typeof body.image_meta_json === "string" && body.image_meta_json
      ? parseJsonField<IntakeImage>(body.image_meta_json, "image_meta_json")
      : null;
    const userId = res.locals.userId as string;
    const image = imageValue ? validateImageMeta(imageValue, getAccountScope(userId)) : null;
    res.json(
      buildIntakePreview(
        ledger.data,
        ledger.revision,
        input,
        image,
        new Date().toISOString(),
      ),
    );
  }),
);

router.post(
  "/intake/commit",
  getUser,
  scopedUser,
  asyncRoute(async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const request = parseJsonField<Submit>(body.payload_json, "payload_json");
    const upload = typeof body.upload_json === "string"
      ? parseJsonField<StoredImageUpload | null>(body.upload_json, "upload_json")
      : null;
    const userId = res.locals.userId as string;

    // An uncertain retry may arrive after the original transaction committed
    // and removed its one-time upload ticket. Check the operation first.
    if (await findOperation(userId, request.operation_id)) {
      const receipt = await commitOperation(userId, request);
      res.json(receipt);
      return;
    }

    let verifiedImage: VerifiedImage | undefined;
    if (upload) {
      const image = validateImageMeta(upload.image, getAccountScope(userId));
      const result = await pool.query<{
        file_name: string;
        byte_size: number;
        mime_type: string;
      }>(
        `SELECT file_name, byte_size, mime_type FROM pending_uploads
         WHERE owner_id = $1 AND object_path = $2`,
        [userId, upload.objectPath],
      );
      const ticket = result.rows[0];
      if (!ticket) throw new AppError(403, "UPLOAD_NOT_OWNED", "图片上传记录不属于当前账号或已过期。");
      if (
        ticket.byte_size !== image.byte_size ||
        ticket.mime_type !== image.mime_type ||
        image.byte_size > MAX_IMAGE_BYTES
      ) {
        throw new AppError(400, "UPLOAD_METADATA", "图片大小或类型与上传记录不匹配。");
      }
      const objectFile = await objectStorage.getObjectEntityFile(upload.objectPath);
      const [metadata] = await objectFile.getMetadata();
      const actualSize = Number(metadata.size);
      const actualType = metadata.contentType;
      if (actualSize !== image.byte_size || actualType !== image.mime_type) {
        throw new AppError(400, "UPLOAD_CONTENT", "上传后的图片与预览信息不匹配。");
      }
      const [bytes] = await objectFile.download();
      const actualHash = createHash("sha256").update(bytes).digest("hex");
      if (actualHash !== image.sha256 || !hasImageSignature(bytes, image.mime_type)) {
        throw new AppError(400, "UPLOAD_HASH", "原图校验失败；没有保存事项。");
      }
      await objectStorage.trySetObjectEntityAclPolicy(upload.objectPath, {
        owner: userId,
        visibility: "private",
      });
      verifiedImage = {
        id: image.id,
        sha256: image.sha256,
        mimeType: image.mime_type,
        byteSize: image.byte_size,
        objectPath: upload.objectPath,
      };
    }

    const receipt = await commitOperation(userId, request, verifiedImage);
    res.status(receipt.duplicate ? 200 : 201).json(receipt);
  }),
);

router.post(
  "/intake/recognize",
  getUser,
  scopedUser,
  (_req, res) => {
    res.status(503).json({
      error: "VISION_UNAVAILABLE",
      message: "当前部署未连接自动识图服务。可以手动填写并核对。",
    });
  },
);

router.post(
  "/intake/codex-result",
  getUser,
  scopedUser,
  (_req, res) => {
    res.status(503).json({
      error: "LOCAL_BRIDGE_UNAVAILABLE",
      message: "本机 Codex 桥接当前不可用。",
    });
  },
);

router.get(
  "/images/:imageId",
  getUser,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const result = await pool.query<{ object_path: string }>(
      "SELECT object_path FROM images WHERE owner_id = $1 AND id = $2",
      [userId, req.params.imageId],
    );
    const row = result.rows[0];
    if (!row) throw new AppError(404, "IMAGE_NOT_FOUND", "没有找到属于当前账号的图片。");
    const objectFile = await objectStorage.getObjectEntityFile(row.object_path);
    const allowed = await objectStorage.canAccessObjectEntity({
      userId,
      objectFile,
      requestedPermission: ObjectPermission.READ,
    });
    if (!allowed) throw new AppError(403, "IMAGE_ACCESS", "无权读取此图片。");
    const response = await objectStorage.downloadObject(objectFile, 0);
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Disposition", "inline");
    if (response.body) {
      Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res);
    } else {
      res.end();
    }
  }),
);

router.use((error: unknown, _req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1], next: Parameters<RequestHandler>[2]) => {
  if (res.headersSent) return next(error);
  if (error instanceof AppError) {
    res.status(error.status).json({ error: error.code, message: error.message, ...error.details });
    return;
  }
  if (error instanceof ObjectNotFoundError) {
    res.status(404).json({ error: "OBJECT_NOT_FOUND", message: "图片文件不存在。" });
    return;
  }
  res.status(500).json({ error: "INTERNAL_ERROR", message: "图片录入请求暂时无法完成。" });
});

type StoredImageUpload = { objectPath: string; image: IntakeImage };

function parseJsonField<T>(value: unknown, name: string): T {
  if (typeof value !== "string" || value.length > 1_000_000) {
    throw new AppError(400, "INVALID_INTAKE", `${name} 格式无效。`);
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new AppError(400, "INVALID_INTAKE", `${name} 不是有效 JSON。`);
  }
}

function validateImageMeta(value: IntakeImage, scope: string): IntakeImage {
  if (
    !value ||
    typeof value.id !== "string" ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(value.sha256) ||
    value.id !== `img_${createHash("sha256").update(`${scope}:${value.sha256}`).digest("hex")}` ||
    !IMAGE_TYPES.includes(value.mime_type) ||
    !Number.isInteger(value.byte_size) ||
    value.byte_size < 1 ||
    value.byte_size > MAX_IMAGE_BYTES ||
    typeof value.uploaded_at !== "string" ||
    !Number.isFinite(Date.parse(value.uploaded_at))
  ) {
    throw new AppError(400, "INVALID_IMAGE_META", "图片预览元数据无效。");
  }
  return value;
}

function hasImageSignature(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === "image/png") {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  return (
    mimeType === "image/webp" &&
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  );
}

export default router;
