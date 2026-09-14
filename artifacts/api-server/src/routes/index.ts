import { Router, type IRouter } from "express";
import healthRouter from "./health";
import fixturesRouter from "./fixtures";

const router: IRouter = Router();

router.use(healthRouter);
router.use(fixturesRouter);

export default router;
