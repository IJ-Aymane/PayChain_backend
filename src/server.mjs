import cors from "cors";
import dotenv from "dotenv";
import express from "express";

import { initDatabase } from "./config/database.mjs";
import { errorHandler, notFoundHandler } from "./middlewares/errorMiddleware.mjs";
import { verifyLocalChainBeforeMutation } from "./middlewares/localChainMiddleware.mjs";
import { applySecurityHeaders } from "./middlewares/securityMiddleware.mjs";
import adminRoutes from "./routes/adminRoutes.mjs";
import authRoutes from "./routes/authRoutes.mjs";
import transactionRoutes from "./routes/transactionRoutes.mjs";
import { isBlockchainEnabled } from "./utils/blockchain.mjs";

dotenv.config();

const app = express();
const port = Number(process.env.PORT ?? 4000);

app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 1));
applySecurityHeaders(app);

app.use(cors({
  origin: process.env.FRONTEND_ORIGIN ?? "http://localhost:5173",
  credentials: true
}));
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok", service: "paychain-backend", network: isBlockchainEnabled() ? "base-sepolia" : "demo", database: "mysql" });
});

app.use("/api", verifyLocalChainBeforeMutation);

app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api", transactionRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

try {
  await initDatabase();
  app.listen(port, () => {
    console.log(`PayChain custodial backend running on http://localhost:${port}`);
  });
} catch (error) {
  console.error("Failed to start PayChain backend:", getStartupErrorMessage(error));
  process.exit(1);
}

function getStartupErrorMessage(error) {
  if (error?.code === "ECONNREFUSED") {
    return "MySQL is not reachable. Start MySQL on 127.0.0.1:3306 or update DB_CONNECTION_STRING in services/backend/.env.";
  }

  return error instanceof Error ? error.message : "Unexpected startup error";
}
