const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readInstanceIdentity } = require("../src/utils/instanceIdentity");
const { renderConfig, customerWorkspaceUrl } = require("../src/utils/renderProvisioning");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("customer instances resolve independent company, currency, region, and control-plane identity", () => {
  const identity = readInstanceIdentity({
    INSTANCE_TENANT_ID: "tenant-123",
    INSTANCE_COMPANY_CODE: "acme-supplies",
    INSTANCE_COMPANY_NAME: "Acme Supplies Ltd",
    INSTANCE_PRIMARY_CURRENCY: "KES",
    INSTANCE_REGION: "africa-east1",
    INSTANCE_TIMEZONE: "Africa/Nairobi",
    INSTANCE_PLAN: "enterprise",
    INSTANCE_CONTROL_PLANE: "false",
  });
  assert.equal(identity.tenantKey, "tenant-123");
  assert.equal(identity.companyName, "Acme Supplies Ltd");
  assert.equal(identity.primaryCurrency, "KES");
  assert.equal(identity.timezone, "Africa/Nairobi");
  assert.equal(identity.plan, "ENTERPRISE");
  assert.equal(identity.controlPlane, false);
  assert.equal(identity.dataIsolationMode, "DEDICATED_DATABASE");
});

test("invalid tenant slugs and currencies fail closed", () => {
  assert.throws(() => readInstanceIdentity({ INSTANCE_COMPANY_CODE: "Acme Supplies" }), /URL-safe/);
  assert.throws(() => readInstanceIdentity({ INSTANCE_COMPANY_CODE: "acme", INSTANCE_PRIMARY_CURRENCY: "shillings" }), /three-letter/);
});

test("the SaaS control plane stores metadata only and provisions dedicated databases", () => {
  const migration = source("prisma/migrations/20260812123000_add_saas_tenant_control_plane/migration.sql");
  const controller = source("src/controllers/tenantController.js");
  const routes = source("src/routes/tenantRoutes.js");
  assert.match(migration, /CREATE TABLE "saas_tenants"/);
  assert.match(migration, /"database_isolation" VARCHAR\(32\) NOT NULL DEFAULT 'DEDICATED_DATABASE'/);
  assert.match(controller, /INSTANCE_TENANT_ID/);
  assert.match(controller, /INSTANCE_CONTROL_PLANE: "false"/);
  assert.doesNotMatch(controller, /DATABASE_URL/);
  assert.match(routes, /authorizePlatformOwner, authorizeControlPlane/);
});

test("tenant monitoring stores hashed credentials and metadata-only error aggregates", () => {
  const migration = source("prisma/migrations/20260812150000_add_tenant_operations_monitoring/migration.sql");
  const telemetry = source("src/controllers/telemetryController.js");
  const reporter = source("src/utils/telemetryReporter.js");
  const routes = source("src/routes/tenantRoutes.js");

  assert.match(migration, /"monitoring_token_hash" VARCHAR\(64\)/);
  assert.match(migration, /CREATE TABLE "tenant_error_aggregates"/);
  assert.match(telemetry, /timingSafeEqual/);
  assert.match(telemetry, /occurrenceCount: \{ increment: 1 \}/);
  assert.doesNotMatch(telemetry, /req\.body\.(message|stack|requestBody)/);
  assert.doesNotMatch(reporter, /stack:/);
  assert.match(routes, /authorizePlatformOwner, authorizeControlPlane/);
  assert.match(routes, /\/operations/);
  assert.match(routes, /errors\/:incidentId\/resolve/);
});

test("automated tenant provisioning is explicit, isolated, resumable, and secret-safe", () => {
  const migration = source("prisma/migrations/20260813203000_add_tenant_provisioning_state/migration.sql");
  const adapter = source("src/utils/renderProvisioning.js");
  const controller = source("src/controllers/tenantController.js");
  const routes = source("src/routes/tenantRoutes.js");
  const disabled = renderConfig({});
  const enabled = renderConfig({ RENDER_API_KEY: "test-key", RENDER_OWNER_ID: "tea-test", STOCKFLOW_FRONTEND_URL: "https://stockflow.example/" });

  assert.equal(disabled.configured, false);
  assert.equal(enabled.configured, true);
  assert.equal(enabled.databasePlan, "basic_256mb");
  assert.equal(customerWorkspaceUrl(enabled, { slug: "acme-ltd" }), "https://stockflow.example/?workspace=acme-ltd");
  assert.match(migration, /provider_database_id/);
  assert.match(migration, /provider_service_id/);
  assert.match(adapter, /connection-info/);
  assert.match(adapter, /crypto\.randomBytes/);
  assert.match(controller, /confirmation !== tenant\.companyName/);
  assert.match(controller, /provisioningStatus: "COMPLETED"/);
  assert.match(routes, /\/resolve\/:slug/);
  assert.match(routes, /\/:id\/provision/);
  assert.match(controller, /connection\.internalConnectionString/);
  assert.doesNotMatch(controller, /DATABASE_URL.*res\.(json|send)/);
});
