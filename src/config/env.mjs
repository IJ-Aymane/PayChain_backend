import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const loadedEnvFiles = [];

loadEnvironment();

export function getLoadedEnvFiles() {
  return [...loadedEnvFiles];
}

export function getEnvironmentSummary() {
  return {
    envFiles: loadedEnvFiles.map((envPath) => path.relative(process.cwd(), envPath) || ".env"),
    hasDbConnectionString: Boolean(process.env.DB_CONNECTION_STRING || process.env.MYSQL_URL || process.env.DATABASE_URL),
    hasMysqlSslCa: Boolean(process.env.MYSQL_SSL_CA),
    frontendOrigin: process.env.FRONTEND_ORIGIN ?? null,
    nodeEnv: process.env.NODE_ENV ?? null,
    render: Boolean(process.env.RENDER)
  };
}

function loadEnvironment() {
  for (const envPath of getEnvFileCandidates()) {
    if (!fs.existsSync(envPath)) {
      continue;
    }

    const result = dotenv.config({ path: envPath, override: false });

    if (!result.error) {
      loadedEnvFiles.push(envPath);
    }
  }
}

function getEnvFileCandidates() {
  return uniquePaths([
    process.env.ENV_FILE,
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), ".env.local"),
    path.resolve(currentDir, "../../.env"),
    path.resolve(currentDir, "../../.env.local")
  ].filter(Boolean));
}

function uniquePaths(paths) {
  return [...new Set(paths.map((envPath) => path.resolve(envPath)))];
}
