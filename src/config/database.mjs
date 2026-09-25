import fs from "node:fs";

import mysql from "mysql2/promise";

let pool;

export async function initDatabase() {
  const config = getDatabaseConfig();

  try {
    await createPoolAndRunMigrations(config);
  } catch (error) {
    if (error?.code !== "ER_BAD_DB_ERROR") {
      throw error;
    }

    await closePool();
    await ensureDatabase(config);
    await createPoolAndRunMigrations(config);
  }
}

export function getPool() {
  if (!pool) {
    throw new Error("MySQL pool is not initialized. Call initDatabase() first.");
  }

  return pool;
}

export async function query(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

export async function execute(sql, params = []) {
  const [result] = await getPool().execute(sql, params);
  return result;
}

export async function withTransaction(handler) {
  const connection = await getPool().getConnection();

  try {
    await connection.beginTransaction();
    const tx = {
      query: async (sql, params = []) => {
        const [rows] = await connection.execute(sql, params);
        return rows;
      },
      execute: async (sql, params = []) => {
        const [result] = await connection.execute(sql, params);
        return result;
      }
    };
    const result = await handler(tx);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function createPoolAndRunMigrations(config) {
  pool = mysql.createPool({
    ...config,
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT ?? 10),
    queueLimit: 0,
    dateStrings: true
  });

  await runMigrations();
  const { initializeLocalBlockchain } = await import("../models/localBlockchainModel.mjs");
  await initializeLocalBlockchain();
}

async function closePool() {
  if (!pool) {
    return;
  }

  await pool.end();
  pool = null;
}

async function ensureDatabase(config) {
  const bootstrap = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    ssl: config.ssl,
    dateStrings: true
  });

  try {
    await bootstrap.query(
      `CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(config.database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await bootstrap.end();
  }
}

async function runMigrations() {
  await execute(`
    CREATE TABLE IF NOT EXISTS users (
      id CHAR(36) PRIMARY KEY,
      email VARCHAR(320) NOT NULL UNIQUE,
      username VARCHAR(64) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      wallet_address VARCHAR(42) NOT NULL UNIQUE,
      encrypted_private_key TEXT NOT NULL,
      failed_login_attempts INT NOT NULL DEFAULT 0,
      locked_until DATETIME NULL,
      last_login_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_users_identifier (email, username),
      INDEX idx_users_wallet_address (wallet_address)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      id CHAR(36) PRIMARY KEY,
      user_id CHAR(36) NOT NULL,
      token_hash CHAR(64) NOT NULL UNIQUE,
      user_agent VARCHAR(255),
      ip_address VARCHAR(64),
      expires_at DATETIME NOT NULL,
      revoked_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX idx_sessions_user_id (user_id),
      INDEX idx_sessions_expiry (expires_at, revoked_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS demo_balances (
      wallet_address VARCHAR(42) PRIMARY KEY,
      pay_balance_units VARCHAR(80) NOT NULL DEFAULT '0',
      eth_balance_units VARCHAR(80) NOT NULL DEFAULT '0',
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_demo_balances_wallet (wallet_address)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS transactions (
      id CHAR(36) PRIMARY KEY,
      type VARCHAR(40) NOT NULL,
      asset VARCHAR(20) NOT NULL,
      from_user_id CHAR(36) NULL,
      to_user_id CHAR(36) NULL,
      from_address VARCHAR(42),
      to_address VARCHAR(42),
      amount VARCHAR(80) NOT NULL,
      tx_hash VARCHAR(66),
      status VARCHAR(30) NOT NULL,
      error TEXT,
      metadata_json JSON NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_transactions_from_user FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE SET NULL,
      CONSTRAINT fk_transactions_to_user FOREIGN KEY (to_user_id) REFERENCES users(id) ON DELETE SET NULL,
      INDEX idx_transactions_from_user (from_user_id, created_at),
      INDEX idx_transactions_to_user (to_user_id, created_at),
      INDEX idx_transactions_tx_hash (tx_hash)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS escrows (
      id CHAR(36) PRIMARY KEY,
      buyer_user_id CHAR(36) NOT NULL,
      seller_user_id CHAR(36) NOT NULL,
      buyer_address VARCHAR(42) NOT NULL,
      seller_address VARCHAR(42) NOT NULL,
      asset VARCHAR(20) NOT NULL,
      amount VARCHAR(80) NOT NULL,
      onchain_escrow_id VARCHAR(80),
      status VARCHAR(30) NOT NULL,
      deposit_tx_hash VARCHAR(66),
      release_tx_hash VARCHAR(66),
      dispute_tx_hash VARCHAR(66),
      refund_tx_hash VARCHAR(66),
      error TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_escrows_buyer FOREIGN KEY (buyer_user_id) REFERENCES users(id),
      CONSTRAINT fk_escrows_seller FOREIGN KEY (seller_user_id) REFERENCES users(id),
      INDEX idx_escrows_buyer (buyer_user_id, created_at),
      INDEX idx_escrows_seller (seller_user_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS local_blocks (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      block_number BIGINT UNSIGNED NOT NULL UNIQUE,
      block_timestamp VARCHAR(32) NOT NULL,
      event_type VARCHAR(80) NOT NULL,
      source_table VARCHAR(80) NOT NULL,
      source_id VARCHAR(120) NOT NULL,
      previous_hash CHAR(64) NOT NULL,
      data_hash CHAR(64) NOT NULL,
      hash CHAR(64) NOT NULL UNIQUE,
      nonce INT NOT NULL DEFAULT 0,
      payload_json LONGTEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_local_blocks_source (source_table, source_id),
      INDEX idx_local_blocks_hash (hash),
      INDEX idx_local_blocks_previous_hash (previous_hash)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

function getDatabaseConfig() {
  const connectionString = process.env.DB_CONNECTION_STRING ?? process.env.MYSQL_URL ?? process.env.DATABASE_URL;

  if (connectionString) {
    return parseMysqlUrl(connectionString);
  }

  if (isProductionRuntime() && !hasExplicitMysqlConfig()) {
    throw new Error("DB_CONNECTION_STRING is required in production. Set it in Render Environment to your Aiven MySQL Service URI.");
  }

  return {
    host: process.env.MYSQL_HOST ?? "127.0.0.1",
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? "paychain",
    password: process.env.MYSQL_PASSWORD ?? "paychain_password",
    database: process.env.MYSQL_DATABASE ?? "paychain",
    ssl: parseSslOption(process.env.MYSQL_SSL)
  };
}

function isProductionRuntime() {
  return process.env.NODE_ENV === "production" || Boolean(process.env.RENDER);
}

function hasExplicitMysqlConfig() {
  return Boolean(process.env.MYSQL_HOST || process.env.MYSQL_USER || process.env.MYSQL_PASSWORD || process.env.MYSQL_DATABASE);
}

function parseMysqlUrl(connectionString) {
  if (!/^mysql:\/\//i.test(connectionString)) {
    throw new Error("DB_CONNECTION_STRING must be a MySQL URL, for example mysql://user:password@localhost:3306/paychain");
  }

  const url = new URL(connectionString);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));

  if (!database) {
    throw new Error("DB_CONNECTION_STRING must include a database name");
  }

  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    ssl: parseSslOption(getMysqlSslValue(url))
  };
}

function getMysqlSslValue(url) {
  return url.searchParams.get("ssl")
    ?? url.searchParams.get("ssl-mode")
    ?? url.searchParams.get("sslmode")
    ?? process.env.MYSQL_SSL;
}

function parseSslOption(value) {
  const normalized = String(value ?? "").trim().toLowerCase();

  if (!normalized || ["false", "0", "disabled", "disable"].includes(normalized)) {
    return undefined;
  }

  if (!["true", "1", "required", "require", "verify-ca", "verify_ca", "verify-full", "verify_identity"].includes(normalized)) {
    return undefined;
  }

  const ssl = {};
  const ca = getMysqlSslCa();

  if (ca) {
    ssl.ca = ca;
  }

  if (String(process.env.MYSQL_SSL_REJECT_UNAUTHORIZED ?? "").trim().toLowerCase() === "false") {
    ssl.rejectUnauthorized = false;
  }

  return ssl;
}

function getMysqlSslCa() {
  if (process.env.MYSQL_SSL_CA) {
    return process.env.MYSQL_SSL_CA.replace(/\\n/g, "\n");
  }

  if (!process.env.MYSQL_SSL_CA_FILE) {
    return undefined;
  }

  return fs.readFileSync(process.env.MYSQL_SSL_CA_FILE, "utf8");
}

function quoteIdentifier(identifier) {
  if (!/^[a-zA-Z0-9_$]+$/.test(identifier)) {
    throw new Error("MYSQL_DATABASE must contain only letters, numbers, underscore or dollar sign");
  }

  return `\`${identifier}\``;
}
