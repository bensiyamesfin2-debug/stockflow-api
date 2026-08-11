const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readInstanceIdentity } = require("../src/utils/instanceIdentity");

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
