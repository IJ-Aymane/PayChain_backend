import { findActiveSessionById, touchSession } from "../models/sessionModel.mjs";
import { findUserById, isUserLocked } from "../models/userModel.mjs";
import { hashToken, verifyToken } from "../utils/auth.mjs";

export async function authenticateRequest(request, response, next) {
  try {
    const { token } = parseBearerToken(request);
    const payload = verifyToken(token);

    if (!payload?.sub || !payload?.sid) {
      response.status(401).json({ error: "Invalid or expired session" });
      return;
    }

    const session = await findActiveSessionById(payload.sid);
    if (!session || session.user_id !== payload.sub || session.token_hash !== hashToken(token)) {
      response.status(401).json({ error: "Invalid or expired session" });
      return;
    }

    const user = await findUserById(payload.sub);
    if (!user) {
      response.status(401).json({ error: "Invalid or expired session" });
      return;
    }

    if (isUserLocked(user)) {
      response.status(423).json({ error: "Account is locked or suspended" });
      return;
    }

    await touchSession(session.id);
    request.auth = payload;
    request.session = session;
    request.user = user;
    next();
  } catch {
    response.status(401).json({ error: "Invalid or expired session" });
  }
}

function parseBearerToken(request) {
  const header = request.headers.authorization ?? "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    throw new Error("Missing bearer token");
  }

  return { token };
}
