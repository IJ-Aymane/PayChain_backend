import { randomUUID } from "node:crypto";

import { execute, query } from "../config/database.mjs";

export async function createUser({ email, username, passwordHash, walletAddress, encryptedPrivateKey }) {
  const user = {
    id: randomUUID(),
    email: normalizeEmail(email),
    username: normalizeUsername(username),
    password_hash: passwordHash,
    wallet_address: walletAddress,
    encrypted_private_key: encryptedPrivateKey
  };

  await execute(
    `INSERT INTO users (id, email, username, password_hash, wallet_address, encrypted_private_key)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [user.id, user.email, user.username, user.password_hash, user.wallet_address, user.encrypted_private_key]
  );

  return findUserById(user.id);
}

export async function findUserById(id) {
  const rows = await query("SELECT * FROM users WHERE id = ? LIMIT 1", [id]);
  return rows[0] ?? null;
}

export async function findUserByEmail(email) {
  const rows = await query("SELECT * FROM users WHERE email = ? LIMIT 1", [normalizeEmail(email)]);
  return rows[0] ?? null;
}

export async function findUserByUsername(username) {
  const rows = await query("SELECT * FROM users WHERE username = ? LIMIT 1", [normalizeUsername(username)]);
  return rows[0] ?? null;
}

export async function findUserByIdentifier(identifier) {
  const raw = String(identifier ?? "").trim();
  const normalized = raw.toLowerCase();

  if (!raw) {
    return null;
  }

  const rows = await query(
    "SELECT * FROM users WHERE email = ? OR username = ? OR id = ? LIMIT 1",
    [normalized, normalized, raw]
  );
  return rows[0] ?? null;
}

export async function incrementFailedLogin(userId, { maxAttempts, lockMinutes }) {
  const user = await findUserById(userId);
  if (!user) {
    return null;
  }

  const attempts = Number(user.failed_login_attempts ?? 0) + 1;
  const lockedUntil = attempts >= maxAttempts ? toMysqlDate(new Date(Date.now() + lockMinutes * 60_000)) : null;

  await execute(
    "UPDATE users SET failed_login_attempts = ?, locked_until = ? WHERE id = ?",
    [attempts, lockedUntil, userId]
  );

  return findUserById(userId);
}

export async function resetLoginSecurity(userId) {
  await execute(
    "UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = CURRENT_TIMESTAMP WHERE id = ?",
    [userId]
  );

  return findUserById(userId);
}

export async function updateUserPassword(userId, passwordHash) {
  await execute(
    "UPDATE users SET password_hash = ?, failed_login_attempts = 0, locked_until = NULL WHERE id = ?",
    [passwordHash, userId]
  );

  return findUserById(userId);
}

export async function suspendUser(userId) {
  await execute("UPDATE users SET locked_until = '2099-01-01 00:00:00' WHERE id = ?", [userId]);
  return findUserById(userId);
}

export async function unsuspendUser(userId) {
  await execute("UPDATE users SET locked_until = NULL, failed_login_attempts = 0 WHERE id = ?", [userId]);
  return findUserById(userId);
}

export async function listUsersForAdmin({ search = "", limit = 100 } = {}) {
  const rawSearch = String(search ?? "").trim();
  const normalizedSearch = `%${rawSearch.toLowerCase()}%`;
  const params = [];
  let where = "";

  if (rawSearch) {
    where = "WHERE LOWER(u.email) LIKE ? OR LOWER(u.username) LIKE ? OR u.id LIKE ? OR LOWER(u.wallet_address) LIKE ?";
    params.push(normalizedSearch, normalizedSearch, `%${rawSearch}%`, normalizedSearch);
  }

  const sanitizedLimit = sanitizeLimit(limit, 100, 300);

  return query(
    `SELECT
       u.id, u.email, u.username, u.wallet_address, u.failed_login_attempts,
       u.locked_until, u.last_login_at, u.created_at,
       COALESCE(db.pay_balance_units, '0') AS pay_balance_units,
       COALESCE(db.eth_balance_units, '0') AS eth_balance_units,
       COUNT(s.id) AS active_sessions
     FROM users u
     LEFT JOIN demo_balances db ON db.wallet_address = u.wallet_address
     LEFT JOIN user_sessions s ON s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP()
     ${where}
     GROUP BY u.id, db.pay_balance_units, db.eth_balance_units
     ORDER BY u.created_at DESC
     LIMIT ${sanitizedLimit}`,
    params
  );
}

export async function countUsers() {
  const rows = await query("SELECT COUNT(*) AS count FROM users");
  return Number(rows[0]?.count ?? 0);
}

export function isUserLocked(user) {
  if (!user?.locked_until) {
    return false;
  }

  return parseMysqlDate(user.locked_until).getTime() > Date.now();
}

export function toSafeUser(user) {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    username: user.username,
    walletAddress: user.wallet_address,
    createdAt: user.created_at,
    lastLoginAt: user.last_login_at
  };
}

export function normalizeEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

export function normalizeUsername(username) {
  return String(username ?? "").trim().toLowerCase();
}

function sanitizeLimit(value, fallback, maximum) {
  const number = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(Math.max(number, 1), maximum);
}

function parseMysqlDate(value) {
  if (value instanceof Date) {
    return value;
  }

  return new Date(`${String(value).replace(" ", "T")}Z`);
}

function toMysqlDate(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}
