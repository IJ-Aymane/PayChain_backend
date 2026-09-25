import express from "express";

import {
  adminSummary,
  adminTransactions,
  adminUsers,
  resetUserDemoBalance,
  setUserDemoBalance,
  suspendUserAccount,
  unsuspendUserAccount
} from "../controllers/adminController.mjs";
import { authenticateRequest } from "../middlewares/authMiddleware.mjs";
import { requireAdmin } from "../middlewares/adminMiddleware.mjs";

const router = express.Router();

router.use(authenticateRequest);
router.use(requireAdmin);

router.get("/summary", adminSummary);
router.get("/users", adminUsers);
router.get("/transactions", adminTransactions);
router.post("/users/:id/reset-demo-balance", resetUserDemoBalance);
router.post("/users/:id/set-demo-balance", setUserDemoBalance);
router.post("/users/:id/suspend", suspendUserAccount);
router.post("/users/:id/unsuspend", unsuspendUserAccount);

export default router;
