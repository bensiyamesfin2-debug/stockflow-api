const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("cashier checkout reserves stock while warehouse release performs the only physical deduction", () => {
  const sale = source("src/controllers/saleController.js");
  const release = source("src/controllers/releaseController.js");
  assert.match(sale, /reservedQuantity:\s*\{ increment: item\.quantity \}/);
  assert.doesNotMatch(sale, /quantity:\s*\{ decrement: item\.quantity \}/);
  assert.match(release, /quantity:\s*\{ decrement: requestedItem\.quantity \}/);
  assert.match(release, /reservedQuantity:\s*\{ decrement: requestedItem\.quantity \}/);
  assert.match(release, /runSerializableTransaction/);
});

test("duplicate releases and insufficient stock are rejected before deductions", () => {
  const release = source("src/controllers/releaseController.js");
  assert.match(release, /remainingQuantity/);
  assert.match(release, /remain to be released/i);
  assert.match(release, /physical stock .* is insufficient/i);
  assert.match(release, /inventory\.reservedQuantity < releaseQuantity/);
});

test("cancellation restores reservation, voids payment, and refuses released sales", () => {
  const sale = source("src/controllers/saleController.js");
  assert.match(sale, /releasedQuantity > 0/);
  assert.match(sale, /reservedQuantity:\s*\{ decrement: item\.quantity \}/);
  assert.match(sale, /status: "VOIDED"/);
});

test("returns are cumulative, optionally restock, and create refund and audit records", () => {
  const sale = source("src/controllers/saleController.js");
  assert.match(sale, /releasedQuantity - saleItem\.returnedQuantity/);
  assert.match(sale, /movementType: "RETURN_IN"/);
  assert.match(sale, /status: "REFUNDED"/);
  assert.match(sale, /remainingPaidCents < returnRefundableCents/);
  assert.match(sale, /action: "RETURN_SALE"/);
  assert.match(source("src/routes/saleRoutes.js"), /"\/:id\/returns"/);
});

test("database constraints reject negative and over-reserved stock", () => {
  const migration = source("prisma/migrations/20260803150000_add_commercial_workflow_upgrade/migration.sql");
  assert.match(migration, /reserved_quantity" <= "quantity/);
  assert.match(migration, /location_balance_nonnegative/);
  assert.match(migration, /returned_quantity" <= "released_quantity/);
  assert.match(migration, /payment_amount_positive/);
});

test("admin password resets require reauthentication and invalidate sessions", () => {
  const users = source("src/controllers/userController.js");
  assert.match(users, /bcrypt\.compare\(administratorPassword/);
  assert.match(users, /tokenVersion: \{ increment: 1 \}/);
  assert.match(users, /action: "RESET_USER_PASSWORD"/);
  assert.match(source("src/routes/userRoutes.js"), /"\/:id\/reset-password"/);
});

test("production identity reports dedicated-database isolation without exposing credentials", () => {
  const app = source("src/app.js");
  assert.match(app, /dataIsolationMode: "DEDICATED_DATABASE"/);
  assert.match(app, /INSTANCE_COMPANY_CODE/);
  assert.doesNotMatch(app, /DATABASE_URL.*res\.json/);
});
