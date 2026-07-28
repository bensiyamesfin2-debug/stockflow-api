const assert = require("node:assert/strict");
const test = require("node:test");
const {
  dashboardSaleInclude,
} = require("../src/utils/dashboardSaleInclude");
const { sellableUnitPriceCents } = require("../src/utils/salePricing");
const {
  calculateCustomOrder,
  normalizeCustomMeasurement,
} = require("../src/utils/customOrder");
const {
  serializePendingReleaseSale,
} = require("../src/utils/releasePrivacy");

test("dashboard recent-sale projection contains the product fields used by the UI", () => {
  assert.equal(dashboardSaleInclude.items.select.id, true);
  assert.equal(dashboardSaleInclude.items.select.quantity, true);
  assert.equal(dashboardSaleInclude.items.select.releasedQuantity, true);
  assert.deepEqual(
    Object.keys(dashboardSaleInclude.items.select.product.select),
    ["id", "sku", "name", "length", "width", "thickness"]
  );
});

test("sales reject products without a positive selling price", () => {
  assert.throws(
    () =>
      sellableUnitPriceCents({
        name: "Galaxy",
        sellingPrice: { toFixed: () => "0.00" },
      }),
    (error) =>
      error.statusCode === 409 &&
      error.message ===
        "Set a selling price for Galaxy before recording a sale"
  );

  assert.equal(
    sellableUnitPriceCents({
      name: "Galaxy",
      sellingPrice: { toFixed: () => "1250.50" },
    }),
    125050n
  );
});

test("custom measurements calculate a definite whole-stock quantity", () => {
  assert.deepEqual(
    calculateCustomOrder(
      { name: "Markino", length: 220, width: 34, thickness: 3 },
      { length: 100, width: 34, thickness: 3, pieces: 3 }
    ),
    { quantity: 2, piecesPerStockUnit: 2 }
  );

  assert.deepEqual(
    calculateCustomOrder(
      { name: "Galaxy", length: 220, width: 50, thickness: 2 },
      { length: 50, width: 20, thickness: 2, pieces: 8 }
    ),
    { quantity: 1, piecesPerStockUnit: 11 }
  );
});

test("custom measurements reject incomplete or impossible cuts", () => {
  const errors = [];
  assert.equal(
    normalizeCustomMeasurement(
      { length: 100, width: "", thickness: 3, pieces: 1 },
      1,
      errors
    ),
    null
  );
  assert.match(errors[0], /positive whole numbers/);

  assert.throws(
    () =>
      calculateCustomOrder(
        { name: "602", length: 125, width: 20, thickness: 2 },
        { length: 200, width: 20, thickness: 2, pieces: 1 }
      ),
    (error) => error.statusCode === 409 && /does not fit/.test(error.message)
  );
});

test("warehouse release data excludes every price and payment field", () => {
  const serialized = serializePendingReleaseSale({
    id: 1,
    saleNumber: "SALE-1",
    clientRequestId: "4d4ebe5a-45a7-4c17-afc1-36a1dbe6dba1",
    totalAmount: "5000.00",
    payments: [{ amount: "5000.00" }],
    items: [{
      id: 2,
      quantity: 2,
      releasedQuantity: 0,
      unitPrice: "2500.00",
      costPriceAtSale: "1500.00",
      product: { inventory: { quantity: 9 } },
    }],
  });

  assert.equal(serialized.totalAmount, undefined);
  assert.equal(serialized.clientRequestId, undefined);
  assert.equal(serialized.payments, undefined);
  assert.equal(serialized.items[0].unitPrice, undefined);
  assert.equal(serialized.items[0].costPriceAtSale, undefined);
  assert.equal(serialized.items[0].remainingQuantity, 2);
});
