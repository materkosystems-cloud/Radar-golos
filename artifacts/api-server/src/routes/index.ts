import { Router, type IRouter } from "express";
import healthRouter from "./health";
import fixturesRouter from "./fixtures";
import pushRouter from "./push";
import historyRouter from "./history";

const router: IRouter = Router();

router.use(healthRouter);
router.use(fixturesRouter);
router.use(pushRouter);
router.use(historyRouter);

export default router;
