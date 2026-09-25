const buckets = new Map();

export function createRateLimiter({ windowMs, max, message }) {
  return (request, response, next) => {
    const now = Date.now();
    const key = `${request.ip}:${request.originalUrl}`;
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    if (bucket.count >= max) {
      response.status(429).json({ error: message });
      return;
    }

    bucket.count += 1;
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}, 60_000).unref();
