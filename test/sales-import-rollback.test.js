const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("sales import batches record a rollback manifest and expose a rollback endpoint", () => {
  const controller = source("src/controllers/saleController.js");
  const routes = source("src/routes/saleRoutes.js");
  const schema = source("prisma/schema.prisma");

  assert.match(schema, /model SalesImportBatch \{[\s\S]*?manifest\s+Json\?/);
  assert.match(schema, /model SalesImportBatch \{[\s\S]*?rolledBackAt\s+DateTime\?/);
  assert.match(schema, /model SalesImportBatch \{[\s\S]*?rolledBackById\s+Int\?/);

  assert.match(controller, /async function rollbackSalesImport/);
  assert.match(routes, /rollbackSalesImport/);
  assert.match(routes, /router\.post\("\/import\/batches\/:id\/rollback", authorizeRoles\("ADMIN"\), rollbackSalesImport\)/);

  // the manifest captured at import time must carry everything rollback needs to reverse it
  assert.match(controller, /saleManifest\.push\(\{ id: sale\.id, saleNumber, status: saleStatus, legacy, productId: product\.id, quantity: row\.quantity, paymentId: payment\?\.id \?\? null \}\)/);
  assert.match(controller, /priceChanges\.push\(\{ productId, previousPriceCents/);
  assert.match(controller, /inventoryReplacements\.push\(\{ productId, previousQuantity/);
  assert.match(controller, /const manifest = \{ saleManifest, priceChanges, inventoryReplacements, inventoryMovementIds, ownerExpenseEntryIds \}/);

  // rollback must refuse rather than guess when the imported data has since changed
  assert.match(controller, /can't roll back safely/);
  assert.match(controller, /imports must be undone most-recent-first/);
  assert.match(controller, /can't roll back its balance safely/);
  assert.match(controller, /Later expense-account entries exist/);

  // only the most recently imported, not-yet-rolled-back batch is ever eligible
  assert.match(controller, /canRollback: !batch\.rolledBackAt && Boolean\(batch\.manifest\) && batch\.id === mostRecentActive\?\.id/);
});
