const crypto = require("crypto");

const API_ROOT = "https://api.render.com/v1";
const RENDER_REGIONS = new Set(["frankfurt", "oregon", "ohio", "singapore", "virginia"]);

class ProvisioningError extends Error {
  constructor(message, statusCode = 502) {
    super(message);
    this.name = "ProvisioningError";
    this.statusCode = statusCode;
  }
}

function renderConfig(environment = process.env) {
  const configured = Boolean(environment.RENDER_API_KEY && environment.RENDER_OWNER_ID);
  return {
    configured,
    apiKey: String(environment.RENDER_API_KEY || ""),
    ownerId: String(environment.RENDER_OWNER_ID || ""),
    repo: String(environment.RENDER_BACKEND_REPO || "https://github.com/bensiyamesfin2-debug/stockflow-api.git"),
    branch: String(environment.RENDER_BACKEND_BRANCH || "main"),
    databasePlan: String(environment.RENDER_DATABASE_PLAN || "basic_256mb"),
    servicePlan: String(environment.RENDER_SERVICE_PLAN || "starter"),
    postgresVersion: String(environment.RENDER_POSTGRES_VERSION || "17"),
    region: RENDER_REGIONS.has(environment.RENDER_REGION) ? environment.RENDER_REGION : "frankfurt",
    frontendUrl: String(environment.STOCKFLOW_FRONTEND_URL || environment.CLIENT_URLS || "https://stockflow-inventory-live.millereli620.chatgpt.site").split(",")[0].replace(/\/$/, ""),
  };
}

async function renderRequest(config, path, options = {}) {
  const response = await fetch(`${API_ROOT}${path}`, {
    ...options,
    headers: { Accept: "application/json", Authorization: `Bearer ${config.apiKey}`, ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
    signal: AbortSignal.timeout(20_000),
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.message || payload?.error || payload?.errors?.[0]?.message || `Render returned ${response.status}`;
    throw new ProvisioningError(`Cloud provisioning failed: ${detail}`, response.status === 429 ? 503 : 502);
  }
  return payload;
}

function renderResourceName(slug, suffix) {
  return `stockflow-${slug}-${suffix}`.slice(0, 63).replace(/-+$/, "");
}

async function createDatabase(config, tenant) {
  return renderRequest(config, "/postgres", { method: "POST", body: JSON.stringify({
    name: renderResourceName(tenant.slug, "db"), databaseName: `stockflow_${tenant.slug.replaceAll("-", "_")}`.slice(0, 63),
    databaseUser: `sf_${tenant.slug.replaceAll("-", "_")}`.slice(0, 63), ownerId: config.ownerId,
    plan: config.databasePlan, version: config.postgresVersion, region: config.region, connectionPool: "none",
  }) });
}

async function getDatabase(config, databaseId) {
  return renderRequest(config, `/postgres/${encodeURIComponent(databaseId)}`);
}

async function getDatabaseConnection(config, databaseId) {
  return renderRequest(config, `/postgres/${encodeURIComponent(databaseId)}/connection-info`);
}

function customerWorkspaceUrl(config, tenant) {
  return `${config.frontendUrl}/?workspace=${encodeURIComponent(tenant.slug)}`;
}

async function createBackendService(config, tenant, databaseUrl, monitoringToken, controlPlaneUrl) {
  const jwtSecret = crypto.randomBytes(48).toString("base64url");
  const frontendUrl = customerWorkspaceUrl(config, tenant);
  const envVars = Object.entries({
    NODE_ENV: "production", DATABASE_URL: databaseUrl, JWT_SECRET: jwtSecret, JWT_EXPIRES_IN: "8h", CLIENT_URLS: config.frontendUrl,
    INSTANCE_TENANT_ID: tenant.id, INSTANCE_COMPANY_CODE: tenant.slug, INSTANCE_COMPANY_NAME: tenant.companyName,
    INSTANCE_PRIMARY_CURRENCY: tenant.primaryCurrency, INSTANCE_LOCALE: tenant.locale, INSTANCE_TIMEZONE: tenant.timezone,
    INSTANCE_REGION: tenant.region, INSTANCE_PLAN: tenant.plan, INSTANCE_PUBLIC_URL: frontendUrl, INSTANCE_CONTROL_PLANE: "false",
    INSTANCE_VERSION: "automated", CONTROL_PLANE_URL: controlPlaneUrl, INSTANCE_MONITORING_TOKEN: monitoringToken,
  }).map(([key, value]) => ({ key, value: String(value) }));
  return renderRequest(config, "/services", { method: "POST", body: JSON.stringify({
    type: "web_service", name: renderResourceName(tenant.slug, "api"), ownerId: config.ownerId, repo: config.repo,
    branch: config.branch, autoDeploy: "yes", envVars,
    serviceDetails: { runtime: "node", plan: config.servicePlan, region: config.region, healthCheckPath: "/api/health", envSpecificDetails: { buildCommand: "npm ci && npm run prisma:generate", startCommand: "npm run start:cloud" } },
  }) });
}

async function getService(config, serviceId) {
  return renderRequest(config, `/services/${encodeURIComponent(serviceId)}`);
}

async function getDeploy(config, serviceId, deployId) {
  return renderRequest(config, `/services/${encodeURIComponent(serviceId)}/deploys/${encodeURIComponent(deployId)}`);
}

module.exports = { renderConfig, createDatabase, getDatabase, getDatabaseConnection, createBackendService, getService, getDeploy, customerWorkspaceUrl, ProvisioningError };
