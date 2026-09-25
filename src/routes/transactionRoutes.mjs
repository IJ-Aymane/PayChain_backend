import express from "express";

import {
  balance,
  claimFaucet,
  createEscrowAction,
  disputeEscrow,
  history,
  localChainStatus,
  profile,
  receipt,
  refundEscrow,
  releaseEscrow,
  statement,
  transfer
} from "../controllers/transactionController.mjs";
import { authenticateRequest } from "../middlewares/authMiddleware.mjs";

const router = express.Router();

router.use(authenticateRequest);

router.get("/profile", profile);
router.get("/balance", balance);
router.get("/history", history);
router.get("/statement", statement);
router.get("/local-chain/status", localChainStatus);
router.get("/transactions/:id/receipt", receipt);
router.post("/faucet/claim", claimFaucet);
router.post("/transfer", transfer);
router.post("/send", transfer);
router.post("/escrow", createEscrowAction);
router.post("/escrow/:id/release", releaseEscrow);
router.post("/escrow/:id/dispute", disputeEscrow);
router.post("/escrow/:id/refund", refundEscrow);

export default router;
