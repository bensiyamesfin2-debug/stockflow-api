const assert = require("node:assert/strict");
const test = require("node:test");
const {
  encryptJsonBackup,
  decryptJsonBackup,
} = require("../src/utils/backupEncryption");
const { buildLowStockAlerts } = require("../src/utils/lowStock");

test("encrypted backups round-trip and reject an incorrect password", () => {
  const source = { products: [{ id: 1, name: "Rice" }], sales: [1, 2] };
  const envelope = encryptJsonBackup(source, "a-strong-backup-password");

  assert.equal(envelope.format, "stockflow-encrypted-backup");
  assert.deepEqual(
    decryptJsonBackup(envelope, "a-strong-backup-password"),
    source
  );
  assert.throws(() => decryptJsonBackup(envelope, "incorrect-password"));
});

test("low-stock alerts prioritize out-of-stock and critical products", () => {
  const alerts = buildLowStockAlerts([
    {
      productId: 1,
      quantity: 10,
      reservedQuantity: 10,
      reorderLevel: 5,
      product: { sku: "A", name: "Out", isActive: true },
    },
    {
      productId: 2,
      quantity: 5,
      reservedQuantity: 3,
      reorderLevel: 6,
      product: { sku: "B", name: "Critical", isActive: true },
    },
    {
      productId: 3,
      quantity: 20,
      reservedQuantity: 0,
      reorderLevel: 5,
      product: { sku: "C", name: "Healthy", isActive: true },
    },
  ]);

  assert.deepEqual(
    alerts.map((alert) => alert.severity),
    ["OUT_OF_STOCK", "CRITICAL"]
  );
  assert.equal(alerts[0].suggestedOrderQuantity, 10);
});
