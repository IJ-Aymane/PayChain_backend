import { createSession, createSessionId, listSessionsForUser, revokeOtherUserSessions, revokeSession } from "../models/sessionModel.mjs";
import {
  createUser,
  findUserByEmail,
  findUserByIdentifier,
  findUserByUsername,
  incrementFailedLogin,
  isUserLocked,
  resetLoginSecurity,
  toSafeUser,
  updateUserPassword
} from "../models/userModel.mjs";
import { generateCustodialWallet } from "../utils/blockchain.mjs";
import {
  generateToken,
  getSessionExpiresAt,
  hashPassword,
  hashToken,
  httpError,
  verifyPassword
} from "../utils/auth.mjs";

const MAX_LOGIN_ATTEMPTS = Number(process.env.MAX_LOGIN_ATTEMPTS ?? 5);
const ACCOUNT_LOCK_MINUTES = Number(process.env.ACCOUNT_LOCK_MINUTES ?? 15);

export async function signup(request, response, next) {
  try {
    const { email, username, password } = request.body;
    validateSignupInput({ email, username, password });

    if (await findUserByEmail(email)) {
      throw httpError(409, "Email already exists");
    }

    if (await findUserByUsername(username)) {
      throw httpError(409, "Username already exists");
    }

    const wallet = generateCustodialWallet();
    const user = await createUser({
      email,
      username,
      passwordHash: await hashPassword(password),
      walletAddress: wallet.address,
      encryptedPrivateKey: wallet.encryptedPrivateKey
    });

    const session = await createAuthenticatedSession(request, user);
    response.status(201).json({ token: session.token, user: toSafeUser(user) });
  } catch (error) {
    next(error);
  }
}

export async function login(request, response, next) {
  try {
    const { identifier, password } = request.body;

    if (!identifier || !password) {
      throw httpError(400, "Identifier and password are required");
    }

    const user = await findUserByIdentifier(identifier);
    if (!user) {
      throw httpError(401, "Invalid credentials");
    }

    if (isUserLocked(user)) {
      throw httpError(423, "Account temporarily locked after too many failed login attempts");
    }

    if (!(await verifyPassword(password, user.password_hash))) {
      const updated = await incrementFailedLogin(user.id, {
        maxAttempts: MAX_LOGIN_ATTEMPTS,
        lockMinutes: ACCOUNT_LOCK_MINUTES
      });

      if (isUserLocked(updated)) {
        throw httpError(423, "Account temporarily locked after too many failed login attempts");
      }

      throw httpError(401, "Invalid credentials");
    }

    const freshUser = await resetLoginSecurity(user.id);
    const session = await createAuthenticatedSession(request, freshUser);

    response.json({ token: session.token, user: toSafeUser(freshUser) });
  } catch (error) {
    next(error);
  }
}

export async function me(request, response, next) {
  try {
    response.json({ user: toSafeUser(request.user) });
  } catch (error) {
    next(error);
  }
}

export async function logout(request, response, next) {
  try {
    await revokeSession(request.session.id);
    response.json({ success: true });
  } catch (error) {
    next(error);
  }
}

export async function sessions(request, response, next) {
  try {
    const items = await listSessionsForUser(request.user.id);
    response.json({ currentSessionId: request.session.id, sessions: items });
  } catch (error) {
    next(error);
  }
}

export async function logoutOtherSessions(request, response, next) {
  try {
    await revokeOtherUserSessions(request.user.id, request.session.id);
    response.json({ success: true });
  } catch (error) {
    next(error);
  }
}

export async function changePassword(request, response, next) {
  try {
    const { currentPassword, newPassword } = request.body;
    const verified = await verifyPassword(currentPassword, request.user.password_hash);

    if (verified === false) {
      throw httpError(401, "Current password is incorrect");
    }

    validatePasswordStrength(newPassword);
    await updateUserPassword(request.user.id, await hashPassword(newPassword));
    await revokeOtherUserSessions(request.user.id, request.session.id);

    response.json({ success: true });
  } catch (error) {
    next(error);
  }
}

function validatePasswordStrength(password) {
  if (typeof password !== "string" || password.length < 8) {
    throw httpError(400, "Password must contain at least 8 characters");
  }

  const hasLetter = /[A-Za-z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  if (hasLetter === false || hasNumber === false) {
    throw httpError(400, "Password must contain letters and numbers");
  }
}

async function createAuthenticatedSession(request, user) {
  const sessionId = createSessionId();
  const token = generateToken(user, sessionId);

  await createSession({
    id: sessionId,
    userId: user.id,
    tokenHash: hashToken(token),
    userAgent: request.headers["user-agent"],
    ipAddress: getClientIp(request),
    expiresAt: getSessionExpiresAt()
  });

  return { token };
}

function validateSignupInput({ email, username, password }) {
  if (!/^\S+@\S+\.\S+$/.test(String(email ?? ""))) {
    throw httpError(400, "A valid email is required");
  }

  if (!/^[a-zA-Z0-9_]{3,24}$/.test(String(username ?? ""))) {
    throw httpError(
      400,
      "Username must be 3-24 characters using letters, numbers or underscore"
    );
  }

  if (typeof password !== "string" || password.length < 8) {
    throw httpError(400, "Password must contain at least 8 characters");
  }
}

function getClientIp(request) {
  const forwardedFor = request.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string") {
    return forwardedFor.split(",")[0].trim();
  }

  return request.ip ?? request.socket?.remoteAddress ?? null;
}
