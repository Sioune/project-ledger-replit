import { Router, type IRouter } from "express";
import healthRouter from "./health";
import ledgerRouter from "./ledger";
import intakeRouter from "./intake";
import storageRouter from "./storage";
import accountImportRouter from "./account-import";
import accountFilesRouter from "./account-files";

const router: IRouter = Router();

router.use(healthRouter);
router.use(ledgerRouter);
router.use(intakeRouter);
router.use(storageRouter);
router.use(accountImportRouter);
router.use(accountFilesRouter);

export default router;
