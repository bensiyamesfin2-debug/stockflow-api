const assert = require("node:assert/strict");
const test = require("node:test");
const {
  dashboardSaleInclude,
} = require("../src/utils/dashboardSaleInclude");
const { sellableUnitPriceCents } = require("../src/utils/salePricing");

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
