const prisma = require("../config/prisma");
const crypto = require("crypto");
const { instanceIdentity, SLUG_PATTERN } = require("../utils/instanceIdentity");

const PLANS = new Set(["STARTER", "GROWTH", "ENTERPRISE"]);
const STATUSES = new Set(["PROVISIONING", "ACTIVE", "SUSPENDED", "ARCHIVED"]);
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const COMPANY_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,38}[A-Z0-9]$/;
const REGION_PATTERN = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;

function clean(value, maximum) {
  const normalized = String(value || "").trim();
  return normalized.slice(0, maximum);
}

function optional(value, maximum) {
  const normalized = clean(value, maximum);
  return normalized || null;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function controlPlaneUrl(req) {
  const origin = String(req.get("origin") || "").replace(/\/$/, "");
  if (/^https:\/\//i.test(origin)) return origin;
  const host = req.get("x-forwarded-host") || req.get("host");
  const protocol = req.get("x-forwarded-proto") || req.protocol;
  return host ? `${protocol}://${host}` : "https://your-control-plane.example";
}

function provisioningConfig(tenant, monitoringToken, publicControlPlaneUrl) {
  const config = {
    INSTANCE_TENANT_ID: tenant.id,
    INSTANCE_COMPANY_CODE: tenant.slug,
    INSTANCE_COMPANY_NAME: tenant.companyName,
    INSTANCE_PRIMARY_CURRENCY: tenant.primaryCurrency,
    INSTANCE_LOCALE: tenant.locale,
    INSTANCE_TIMEZONE: tenant.timezone,
    INSTANCE_REGION: tenant.region,
    INSTANCE_PLAN: tenant.plan,
    INSTANCE_CONTROL_PLANE: "false",
  };
  if (monitoringToken) {
    config.CONTROL_PLANE_URL = publicControlPlaneUrl;
    config.INSTANCE_MONITORING_TOKEN = monitoringToken;
  }
  return config;
}

function serializeTenant(tenant) {
  const { monitoringTokenHash, ...safeTenant } = tenant;
  return { ...safeTenant, monitoringConfigured: Boolean(monitoringTokenHash), provisioningConfig: provisioningConfig(tenant) };
}

async function ensureCurrentTenant() {
  return prisma.saasTenant.upsert({
    where: { slug: instanceIdentity.companyCode },
    update: {
      companyName: instanceIdentity.companyName,
      primaryCurrency: instanceIdentity.primaryCurrency,
      locale: instanceIdentity.locale,
      timezone: instanceIdentity.timezone,
      region: instanceIdentity.region,
      plan: instanceIdentity.plan,
      deploymentUrl: instanceIdentity.publicUrl || undefined,
    },
    create: {
      companyName: instanceIdentity.companyName,
      companyCode: instanceIdentity.companyCode.replaceAll("-", "_").toUpperCase(),
      slug: instanceIdentity.companyCode,
      status: "ACTIVE",
      plan: instanceIdentity.plan,
      primaryCurrency: instanceIdentity.primaryCurrency,
      locale: instanceIdentity.locale,
      timezone: instanceIdentity.timezone,
      region: instanceIdentity.region,
      deploymentUrl: instanceIdentity.publicUrl,
      databaseIsolation: instanceIdentity.dataIsolationMode,
      activatedAt: new Date(),
    },
  });
}

async function listTenants(req, res) {
  await ensureCurrentTenant();
  const tenants = await prisma.saasTenant.findMany({
    include: { createdBy: { select: { id: true, fullName: true, username: true } } },
    orderBy: [{ status: "asc" }, { companyName: "asc" }],
  });
  return res.json({ success: true, data: { tenants: tenants.map(serializeTenant) } });
}

async function createTenant(req, res) {
  const companyName = clean(req.body.companyName, 160);
  const slug = clean(req.body.slug, 80).toLowerCase();
  const companyCode = clean(req.body.companyCode || slug.replaceAll("-", "_"), 40).toUpperCase();
  const primaryCurrency = clean(req.body.primaryCurrency || "ETB", 3).toUpperCase();
  const locale = clean(req.body.locale || "en", 10);
  const timezone = clean(req.body.timezone || "Africa/Addis_Ababa", 64);
  const region = clean(req.body.region || "africa-east1", 48).toLowerCase();
  const plan = clean(req.body.plan || "GROWTH", 24).toUpperCase();
  const notes = optional(req.body.notes, 4000);
  const monitoringToken = crypto.randomBytes(32).toString("base64url");

  if (!companyName || !SLUG_PATTERN.test(slug) || !COMPANY_CODE_PATTERN.test(companyCode)) {
    return res.status(400).json({ success: false, message: "Enter a company name, a URL-safe slug, and a valid company code" });
  }
  if (!CURRENCY_PATTERN.test(primaryCurrency) || !PLANS.has(plan) || !REGION_PATTERN.test(region) || !timezone) {
    return res.status(400).json({ success: false, message: "Enter a valid currency, plan, region, and timezone" });
  }

  try {
    const tenant = await prisma.$transaction(async (transaction) => {
      const created = await transaction.saasTenant.create({
        data: {
          companyName,
          companyCode,
          slug,
          plan,
          primaryCurrency,
          locale,
          timezone,
          region,
          notes,
          monitoringTokenHash: hashToken(monitoringToken),
          createdById: req.user.id,
        },
        include: { createdBy: { select: { id: true, fullName: true, username: true } } },
      });
      await transaction.auditLog.create({
        data: {
          userId: req.user.id,
          action: "REGISTER_SAAS_TENANT",
          entityType: "SAAS_TENANT",
          details: { tenantId: created.id, companyName, slug, plan, dataIsolationMode: created.databaseIsolation },
        },
      });
      return created;
    });
    return res.status(201).json({
      success: true,
      message: `${companyName} is registered and ready for its isolated StockFlow deployment`,
      data: { tenant: { ...serializeTenant(tenant), provisioningConfig: provisioningConfig(tenant, monitoringToken, controlPlaneUrl(req)) } },
    });
  } catch (error) {
    if (error.code === "P2002") {
      return res.status(409).json({ success: false, message: "That company code, slug, or deployment URL is already registered" });
    }
    throw error;
  }
}

async function updateTenant(req, res) {
  const id = String(req.params.id || "");
  const existing = await prisma.saasTenant.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ success: false, message: "Customer workspace not found" });

  const status = req.body.status === undefined ? existing.status : clean(req.body.status, 24).toUpperCase();
  const deploymentUrl = req.body.deploymentUrl === undefined ? existing.deploymentUrl : optional(req.body.deploymentUrl, 500);
  const notes = req.body.notes === undefined ? existing.notes : optional(req.body.notes, 4000);
  if (!STATUSES.has(status)) return res.status(400).json({ success: false, message: "Choose a valid customer status" });
  if (deploymentUrl && !/^https:\/\//i.test(deploymentUrl)) {
    return res.status(400).json({ success: false, message: "Deployment URL must use HTTPS" });
  }
  if (status === "ACTIVE" && existing.slug !== instanceIdentity.companyCode && !deploymentUrl) {
    return res.status(400).json({ success: false, message: "Add the customer deployment URL before activating the workspace" });
  }

  try {
    const tenant = await prisma.$transaction(async (transaction) => {
      const updated = await transaction.saasTenant.update({
        where: { id },
        data: {
          status,
          deploymentUrl,
          notes,
          activatedAt: status === "ACTIVE" ? existing.activatedAt || new Date() : existing.activatedAt,
        },
        include: { createdBy: { select: { id: true, fullName: true, username: true } } },
      });
      await transaction.auditLog.create({
        data: {
          userId: req.user.id,
          action: "UPDATE_SAAS_TENANT",
          entityType: "SAAS_TENANT",
          details: { tenantId: id, status, deploymentUrl: deploymentUrl || null },
        },
      });
      return updated;
    });
    return res.json({ success: true, message: "Customer workspace updated", data: { tenant: serializeTenant(tenant) } });
  } catch (error) {
    if (error.code === "P2002") return res.status(409).json({ success: false, message: "That deployment URL is already assigned" });
    throw error;
  }
}

function operationalHealth(tenant, now = Date.now()) {
  if (["SUSPENDED", "ARCHIVED"].includes(tenant.status)) return "PAUSED";
  if (!tenant.lastHeartbeatAt) return "NOT_CONNECTED";
  if (now - new Date(tenant.lastHeartbeatAt).getTime() > 15 * 60_000) return "OFFLINE";
  return tenant.lastHealthStatus || "UNKNOWN";
}

async function operationsOverview(req, res) {
  await ensureCurrentTenant();
  const current = await prisma.saasTenant.findUnique({ where: { slug: instanceIdentity.companyCode } });
  if (current) {
    await prisma.saasTenant.update({
      where: { id: current.id },
      data: {
        lastHeartbeatAt: new Date(), lastHealthStatus: "HEALTHY", lastDatabaseOk: true,
        lastVersion: String(process.env.INSTANCE_VERSION || process.env.RAILWAY_GIT_COMMIT_SHA || "current").slice(0, 80),
        lastUptimeSeconds: Math.round(process.uptime()), lastMemoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
    });
  }
  const [tenants, incidents] = await Promise.all([
    prisma.saasTenant.findMany({ orderBy: { companyName: "asc" } }),
    prisma.tenantErrorAggregate.findMany({ where: { resolvedAt: null, occurrenceCount: { gte: 3 } }, include: { tenant: { select: { id: true, companyName: true, slug: true } } }, orderBy: { lastSeenAt: "desc" }, take: 100 }),
  ]);
  const healthTenants = tenants.map((tenant) => ({
    id: tenant.id, companyName: tenant.companyName, slug: tenant.slug, status: tenant.status, plan: tenant.plan,
    deploymentUrl: tenant.deploymentUrl, health: operationalHealth(tenant), lastHeartbeatAt: tenant.lastHeartbeatAt,
    databaseOk: tenant.lastDatabaseOk, version: tenant.lastVersion, uptimeSeconds: tenant.lastUptimeSeconds,
    memoryMb: tenant.lastMemoryMb, lastErrorAt: tenant.lastErrorAt,
  }));
  const healthy = healthTenants.filter((tenant) => tenant.health === "HEALTHY").length;
  const attention = healthTenants.filter((tenant) => !["HEALTHY", "PAUSED"].includes(tenant.health)).length;
  return res.json({ success: true, data: { checkedAt: new Date().toISOString(), summary: { total: tenants.length, healthy, attention, repeatedIncidents: incidents.length }, tenants: healthTenants, incidents } });
}

async function rotateMonitoringToken(req, res) {
  const id = String(req.params.id || "");
  const tenant = await prisma.saasTenant.findUnique({ where: { id } });
  if (!tenant) return res.status(404).json({ success: false, message: "Customer workspace not found" });
  const monitoringToken = crypto.randomBytes(32).toString("base64url");
  await prisma.saasTenant.update({ where: { id }, data: { monitoringTokenHash: hashToken(monitoringToken), lastHeartbeatAt: null, lastHealthStatus: "UNKNOWN" } });
  await prisma.auditLog.create({ data: { userId: req.user.id, action: "ROTATE_TENANT_MONITORING_TOKEN", entityType: "SAAS_TENANT", details: { tenantId: id } } });
  return res.json({ success: true, message: "Monitoring token rotated. Update the customer deployment now.", data: { provisioningConfig: provisioningConfig(tenant, monitoringToken, controlPlaneUrl(req)) } });
}

async function resolveIncident(req, res) {
  const tenantId = String(req.params.id || "");
  const incidentId = Number(req.params.incidentId);
  const incident = await prisma.tenantErrorAggregate.findFirst({ where: { id: incidentId, tenantId } });
  if (!incident) return res.status(404).json({ success: false, message: "Incident not found" });
  await prisma.$transaction([
    prisma.tenantErrorAggregate.update({ where: { id: incidentId }, data: { resolvedAt: new Date() } }),
    prisma.auditLog.create({ data: { userId: req.user.id, action: "RESOLVE_TENANT_INCIDENT", entityType: "TENANT_ERROR", details: { tenantId, incidentId } } }),
  ]);
  return res.json({ success: true, message: "Incident marked resolved" });
}

module.exports = { listTenants, createTenant, updateTenant, operationsOverview, rotateMonitoringToken, resolveIncident, provisioningConfig, serializeTenant, operationalHealth };
