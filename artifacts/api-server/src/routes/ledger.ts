import { Router, type IRouter, type RequestHandler } from "express";
import {
  AppError,
  preview as buildPreview,
  type Ledger,
  type Submit,
} from "../lib/ledger-domain/model";
import {
  commitOperation,
  emptyLedger,
  exportAccount,
  findOperation,
  initializeLedger,
  listOperations,
  readLedger,
  undoOperation,
} from "../lib/ledger-store";
import { exportAccountBackupArchive } from "../lib/account-backup";
import {
  ensureAccount,
  getAccountScope,
  requireUser,
  verifyAccountScope,
  verifySameOrigin,
} from "../lib/auth";

const router: IRouter = Router();

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
  const userId = res.locals.userId as string;
  if (!verifyAccountScope(req, res, userId)) return;
  next();
};

const asyncRoute = (handler: RequestHandler): RequestHandler => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

router.get(
  "/state",
  getUser,
  asyncRoute(async (_req, res) => {
    const userId = res.locals.userId as string;
    const ledger = await readLedger(userId);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      initialized: !!ledger,
      revision: ledger?.revision ?? 0,
      data: ledger?.data ?? null,
      identity: { displayName: "本人", draftScope: getAccountScope(userId) },
    });
  }),
);

router.post(
  "/initialize",
  getUser,
  scopedUser,
  asyncRoute(async (_req, res) => {
    const ledger = await initializeLedger(res.locals.userId as string);
    res.status(201).json({
      initialized: true,
      revision: ledger.revision,
      data: ledger.data,
    });
  }),
);

router.get(
  "/calendar",
  getUser,
  scopedUser,
  asyncRoute(async (_req, res) => {
    const ledger = await readLedger(res.locals.userId as string);
    const data = ledger?.data ?? emptyLedger();
    res.setHeader("Cache-Control", "no-store");
    res.json({
      revision: ledger?.revision ?? 0,
      timezone: "Asia/Shanghai",
      generated_at: new Date().toISOString(),
      history_complete: true,
      warnings: [],
      tasks: data.tasks.map((task) => ({
        ...task,
        registered_at: task.created_at ?? null,
        registration_source: task.created_at ? "recorded" : "unknown",
      })),
      projects: data.projects.map((project) => ({
        ...project,
        registered_at: project.created_at ?? null,
        registration_source: project.created_at ? "recorded" : "unknown",
      })),
    });
  }),
);

router.post(
  "/preview",
  getUser,
  scopedUser,
  asyncRoute(async (req, res) => {
    const ledger = await readLedger(res.locals.userId as string);
    if (!ledger) throw new AppError(409, "NOT_INITIALIZED", "请先创建个人空间。");
    const body = req.body as Record<string, unknown>;
    if (
      typeof body.text !== "string" ||
      body.text.trim().length === 0 ||
      body.text.length > 5000 ||
      typeof body.source_event_id !== "string" ||
      typeof body.occurred_at !== "string" ||
      !Number.isFinite(Date.parse(body.occurred_at))
    ) {
      throw new AppError(400, "INVALID_PREVIEW", "预览请求格式无效。");
    }
    res.json(
      buildPreview(
        body.text,
        ledger.data,
        ledger.revision,
        body.source_event_id,
        body.occurred_at,
      ),
    );
  }),
);

router.post(
  "/operations",
  getUser,
  scopedUser,
  asyncRoute(async (req, res) => {
    const receipt = await commitOperation(
      res.locals.userId as string,
      req.body as Submit,
    );
    res.status(receipt.duplicate ? 200 : 201).json(receipt);
  }),
);

router.get(
  "/operations",
  getUser,
  scopedUser,
  asyncRoute(async (_req, res) => {
    const operations = await listOperations(res.locals.userId as string);
    res.setHeader("Cache-Control", "no-store");
    res.json({ operations });
  }),
);

router.get(
  "/operations/:operationId",
  getUser,
  scopedUser,
  asyncRoute(async (req, res) => {
    const operationId = Array.isArray(req.params.operationId)
      ? req.params.operationId[0]
      : req.params.operationId;
    if (!operationId) throw new AppError(404, "OPERATION_NOT_FOUND", "未找到该操作回执。");
    const operation = await findOperation(
      res.locals.userId as string,
      operationId,
    );
    if (!operation) throw new AppError(404, "OPERATION_NOT_FOUND", "未找到该操作回执。");
    res.setHeader("Cache-Control", "no-store");
    res.json(operation);
  }),
);

router.post(
  "/undo",
  getUser,
  scopedUser,
  asyncRoute(async (req, res) => {
    const body = req.body as Record<string, unknown>;
    if (
      typeof body.operation_id !== "string" ||
      !Number.isInteger(body.base_version) ||
      typeof body.idempotency_key !== "string"
    ) {
      throw new AppError(400, "INVALID_UNDO", "撤销请求格式无效。");
    }
    const receipt = await undoOperation(
      res.locals.userId as string,
      body.operation_id,
      body.base_version as number,
      body.idempotency_key,
    );
    res.json(receipt);
  }),
);

router.get(
  "/export",
  getUser,
  scopedUser,
  asyncRoute(async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(await exportAccount(res.locals.userId as string));
  }),
);

router.get(
  "/account-backup",
  getUser,
  scopedUser,
  asyncRoute(async (_req, res) => {
    const exportData = await exportAccountBackupArchive(res.locals.userId as string);
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="project-ledger-${date}.zip"`,
    );
    res.type("application/zip").send(exportData);
  }),
);

router.use((error: unknown, _req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1], next: Parameters<RequestHandler>[2]) => {
  if (res.headersSent) return next(error);
  if (error instanceof AppError) {
    res.status(error.status).json({
      error: error.code,
      message: error.message,
      ...error.details,
    });
    return;
  }
  res.status(500).json({ error: "INTERNAL_ERROR", message: "服务器暂时无法完成请求。" });
});

export default router;
