import express from "express";

import { changePassword, login, logout, logoutOtherSessions, me, sessions, signup } from "../controllers/authController.mjs";
import { authenticateRequest } from "../middlewares/authMiddleware.mjs";
import { createRateLimiter } from "../middlewares/rateLimitMiddleware.mjs";

const router = express.Router();
const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATE_LIMIT_MAX ?? 30),
  message: "Too many authentication attempts. Please try again later."
});

router.post("/signup", authLimiter, signup);
router.post("/login", authLimiter, login);
router.get("/me", authenticateRequest, me);
router.post("/logout", authenticateRequest, logout);
router.get("/sessions", authenticateRequest, sessions);
router.post("/logout-other-sessions", authenticateRequest, logoutOtherSessions);
router.post("/change-password", authenticateRequest, changePassword);

export default router;
