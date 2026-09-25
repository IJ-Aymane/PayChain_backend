import crypto from "node:crypto";

import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const SALT_ROUNDS = 12;

export async function hashPassword(password) {
  assertPasswordPolicy(password);
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password, passwordHash) {
  if (typeof password !== "string" || !passwordHash) {
    return false;
  }

  return bcrypt.compare(password, passwordHash);
}

export function generateToken(user, sessionId) {
  return jwt.sign(
    {
      sub: user.id,
      sid: sessionId,
      email: user.email,
      username: user.username
    },
    getJwtSecret(),
    { expiresIn: `${getSessionTtlHours()}h` }
  );
}

export function verifyToken(token) {
  return jwt.verify(token, getJwtSecret());
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function getSessionExpiresAt() {
  return new Date(Date.now() + getSessionTtlHours() * 60 * 60 * 1000);
}

export function assertPasswordPolicy(password) {
  if (typeof password !== "string" || password.length < 8) {
    throw httpError(400, "Password must contain at least 8 characters");
  }
}

export function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 24) {
    throw new Error("JWT_SECRET must be set to a long random value");
  }

  return secret;
}

function getSessionTtlHours() {
  const ttl = Number(process.env.SESSION_TTL_HOURS ?? 12);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : 12;
}
