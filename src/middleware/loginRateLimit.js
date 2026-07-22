const WINDOW_MILLISECONDS = 15 * 60 * 1000;
const MAXIMUM_ATTEMPTS_PER_ADDRESS = 20;
const attemptsByAddress = new Map();

function loginRateLimit(req, res, next) {
  const now = Date.now();
  const address = req.ip || req.socket.remoteAddress || "unknown";
  const existing = attemptsByAddress.get(address);
  const bucket =
    !existing || existing.resetAt <= now
      ? { count: 0, resetAt: now + WINDOW_MILLISECONDS }
      : existing;

  bucket.count += 1;
  attemptsByAddress.set(address, bucket);

  if (attemptsByAddress.size > 5000) {
    for (const [key, value] of attemptsByAddress) {
      if (value.resetAt <= now) attemptsByAddress.delete(key);
    }
  }

  if (bucket.count > MAXIMUM_ATTEMPTS_PER_ADDRESS) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((bucket.resetAt - now) / 1000)
    );
    res.setHeader("Retry-After", String(retryAfterSeconds));
    return res.status(429).json({
      success: false,
      message: "Too many sign-in requests. Please try again later.",
    });
  }

  return next();
}

module.exports = { loginRateLimit };
