import { httpError } from "../utils/auth.mjs";

export function requireAdmin(request, _response, next) {
  try {
    if (isConfiguredAdmin(request.user)) {
      next();
      return;
    }

    throw httpError(403, "Admin access required. Add this user id, email or username to ADMIN_IDENTIFIERS in services/backend/.env.");
  } catch (error) {
    next(error);
  }
}

function isConfiguredAdmin(user) {
  const identifiers = String(process.env.ADMIN_IDENTIFIERS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (identifiers.length === 0) {
    return false;
  }

  const userKeys = [user.id, user.email, user.username].map((value) => String(value).toLowerCase());
  return userKeys.some((value) => identifiers.includes(value));
}
