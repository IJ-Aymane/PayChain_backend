import { randomUUID } from "node:crypto";

import { execute, query } from "../config/database.mjs";

export function createSessionId() {
  return randomUUID();
}

export async function createSession({ id, userId, tokenHash, userAgent, ipAddress, expiresAt }) {
  await execute(
    `INSERT INTO user_sessions (id, user_id, token_hash, user_agent, ip_address, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, userId, tokenHash, trim(userAgent, 255), trim(ipAddress, 64), toMysqlDate(expiresAt)]
  );

  return findSessionById(id);
}

export async function findSessionById(id) {
  const rows = await query("SELECT * FROM user_sessions WHERE id = ? LIMIT 1", [id]);
  return rows[0] ?? null;
}

export async function findActiveSessionById(id) {
  const rows = await query(
    `SELECT * FROM user_sessions
     WHERE id = ? AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP()
     LIMIT 1`,
    [id]
  );
  return rows[0] ?? null;
}

export async function touchSession(id) {
  await execute("UPDATE user_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
}


export async function listSessionsForUser(userId) {
  return query(
    `SELECT id, user_agent, ip_address, expires_at, revoked_at, created_at, last_seen_at
     FROM user_sessions
     WHERE user_id = ?
     ORDER BY last_seen_at DESC`,
    [userId]
  );
}

export async function revokeOtherUserSessions(userId, currentSessionId) {
  await execute(
    `UPDATE user_sessions
     SET revoked_at = CURRENT_TIMESTAMP
     WHERE user_id = ? AND id <> ? AND revoked_at IS NULL`,
    [userId, currentSessionId]
  );
}

export async function revokeSession(id) {
  await execute("UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL", [id]);
}

export async function revokeAllUserSessions(userId) {
  await execute("UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL", [userId]);
}

export async function pruneExpiredSessions() {
  await execute("DELETE FROM user_sessions WHERE expires_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)");
}

function trim(value, maxLength) {
  if (!value) {
    return null;
  }

  return String(value).slice(0, maxLength);
}

function toMysqlDate(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}
