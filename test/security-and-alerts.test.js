const assert = require("node:assert/strict");
const test = require("node:test");
const {
  encryptJsonBackup,
  decryptJsonBackup,
} = require("../src/utils/backupEncryption");
const { buildLowStockAlerts } = require("../src/utils/lowStock");
const {
  createPairingCredential,
  getPairingState,
  hashPairingToken,
} = require("../src/utils/loginPairing");
const { normalizeClientRequestId } = require("../src/utils/clientRequestId");

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

test("phone pairing credentials are high-entropy, hashed, short-lived, and single-state", () => {
  const now = new Date("2026-07-22T09:00:00.000Z");
  const credential = createPairingCredential(now);

  assert.match(credential.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(credential.tokenHash, hashPairingToken(credential.token));
  assert.notEqual(credential.tokenHash, credential.token);
  assert.equal(
    getPairingState({ usedAt: null, expiresAt: credential.expiresAt }, now),
    "PENDING"
  );
  assert.equal(
    getPairingState({ usedAt: null, expiresAt: credential.expiresAt }, credential.expiresAt),
    "EXPIRED"
  );
  assert.equal(
    getPairingState({ usedAt: now, expiresAt: credential.expiresAt }, now),
    "USED"
  );
});

test("offline sale synchronization accepts canonical UUIDs and rejects unsafe IDs", () => {
  assert.equal(
    normalizeClientRequestId("4D4EBE5A-45A7-4C17-AFC1-36A1DBE6DBA1"),
    "4d4ebe5a-45a7-4c17-afc1-36a1dbe6dba1"
  );
  assert.equal(normalizeClientRequestId(undefined), null);
  assert.equal(normalizeClientRequestId("sale-123"), undefined);
});
