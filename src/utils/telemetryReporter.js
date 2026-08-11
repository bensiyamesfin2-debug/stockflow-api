const crypto = require("crypto");
const { instanceIdentity } = require("./instanceIdentity");

const controlPlaneUrl = String(process.env.CONTROL_PLANE_URL || "").replace(/\/$/, "");
const monitoringToken = String(process.env.INSTANCE_MONITORING_TOKEN || "");
let heartbeatTimer;

function enabled() {
  return Boolean(controlPlaneUrl && monitoringToken && !instanceIdentity.controlPlane);
}

async function send(path, body) {
  if (!enabled()) return;
  try {
    await fetch(`${controlPlaneUrl}/api/telemetry/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-stockflow-monitoring-token": monitoringToken },
      body: JSON.stringify({ tenantId: instanceIdentity.tenantKey, ...body }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    // Monitoring must never interrupt customer operations.
  }
}

async function reportHeartbeat(prisma) {
  let databaseOk = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseOk = true;
  } catch {}
  await send("heartbeat", {
    status: databaseOk ? "HEALTHY" : "UNHEALTHY",
    databaseOk,
    version: String(process.env.INSTANCE_VERSION || process.env.RAILWAY_GIT_COMMIT_SHA || "unknown").slice(0, 80),
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  });
}

function reportInstanceError(error, req, statusCode = 500) {
  if (!enabled()) return;
  const route = String(req.originalUrl || req.path || "/unknown").split("?")[0].slice(0, 200);
  const errorType = String(error?.name || "Error").slice(0, 120);
  const fingerprint = crypto.createHash("sha256").update(`${errorType}|${error?.message || ""}|${req.method}|${route}`).digest("hex");
  void send("error", { fingerprint, errorType, route, method: req.method, statusCode });
}

function startTelemetryReporter(prisma) {
  if (!enabled()) return;
  void reportHeartbeat(prisma);
  heartbeatTimer = setInterval(() => void reportHeartbeat(prisma), 5 * 60_000);
  heartbeatTimer.unref();
}

function stopTelemetryReporter() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
}

module.exports = { startTelemetryReporter, stopTelemetryReporter, reportInstanceError, reportHeartbeat };
