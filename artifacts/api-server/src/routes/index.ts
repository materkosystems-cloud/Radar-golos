import { Router, type IRouter } from "express";
import healthRouter from "./health";
import fixturesRouter from "./fixtures";
import pushRouter from "./push";

const router: IRouter = Router();

router.use(healthRouter);
router.use(fixturesRouter);
router.use(pushRouter);

export default router;
