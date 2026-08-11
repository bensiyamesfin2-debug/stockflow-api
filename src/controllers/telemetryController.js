const crypto = require("crypto");
const prisma = require("../config/prisma");

const requests = new Map();
const HEX_64 = /^[a-f0-9]{64}$/;
const HEALTH_STATUSES = new Set(["HEALTHY", "DEGRADED", "UNHEALTHY"]);

function clean(value, maximum) {
  return String(value || "").trim().slice(0, maximum);
}

function digest(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function sameHash(actual, expected) {
  if (!actual || !expected || actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function withinRateLimit(key) {
  const now = Date.now();
  const current = requests.get(key);
  if (!current || now - current.startedAt >= 60_000) {
    if (!current && requests.size >= 10_000) return false;
    requests.set(key, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= 60;
}

async function authenticateReporter(req, res) {
  const tenantId = clean(req.body.tenantId, 80);
  const token = clean(req.get("x-stockflow-monitoring-token"), 200);
  if (!tenantId || !token) {
    res.status(401).json({ success: false, message: "Telemetry credentials are invalid" });
    return null;
  }
  if (!withinRateLimit(`${req.ip}:${tenantId}`)) {
    res.status(429).json({ success: false, message: "Telemetry request rejected" });
    return null;
  }
  const tenant = await prisma.saasTenant.findUnique({ where: { id: tenantId } });
  if (!tenant?.monitoringTokenHash || !sameHash(digest(token), tenant.monitoringTokenHash)) {
    res.status(401).json({ success: false, message: "Telemetry credentials are invalid" });
    return null;
  }
  return tenant;
}

async function heartbeat(req, res) {
  const tenant = await authenticateReporter(req, res);
  if (!tenant) return;
  const status = clean(req.body.status, 24).toUpperCase();
  const dbOk = req.body.databaseOk === true;
  if (!HEALTH_STATUSES.has(status)) return res.status(400).json({ success: false, message: "Invalid health status" });
  await prisma.saasTenant.update({
    where: { id: tenant.id },
    data: {
      lastHeartbeatAt: new Date(),
      lastHealthStatus: dbOk ? status : "UNHEALTHY",
      lastDatabaseOk: dbOk,
      lastVersion: clean(req.body.version, 80) || null,
      lastUptimeSeconds: Math.max(0, Math.min(Number(req.body.uptimeSeconds) || 0, 2_147_483_647)),
      lastMemoryMb: Math.max(0, Math.min(Number(req.body.memoryMb) || 0, 2_147_483_647)),
    },
  });
  return res.json({ success: true });
}

async function reportError(req, res) {
  const tenant = await authenticateReporter(req, res);
  if (!tenant) return;
  const fingerprint = clean(req.body.fingerprint, 64).toLowerCase();
  const errorType = clean(req.body.errorType, 120) || "Error";
  const route = clean(req.body.route, 200).split("?")[0] || "/unknown";
  const method = clean(req.body.method, 10).toUpperCase() || "UNKNOWN";
  const statusCode = Math.max(500, Math.min(Number(req.body.statusCode) || 500, 599));
  if (!HEX_64.test(fingerprint)) return res.status(400).json({ success: false, message: "Invalid error fingerprint" });
  const now = new Date();
  await prisma.$transaction([
    prisma.tenantErrorAggregate.upsert({
      where: { tenantId_fingerprint: { tenantId: tenant.id, fingerprint } },
      create: { tenantId: tenant.id, fingerprint, errorType, route, method, statusCode, firstSeenAt: now, lastSeenAt: now },
      update: { errorType, route, method, statusCode, occurrenceCount: { increment: 1 }, lastSeenAt: now, resolvedAt: null },
    }),
    prisma.saasTenant.update({ where: { id: tenant.id }, data: { lastErrorAt: now } }),
  ]);
  return res.status(202).json({ success: true });
}

module.exports = { heartbeat, reportError, digest, sameHash };
