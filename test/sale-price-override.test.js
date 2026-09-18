const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
process.env.DATABASE_URL ||= "postgresql://postgres:postgres@127.0.0.1:5432/stockflow_test";
const { validateSaleRequest } = require("../src/controllers/saleController");

function baseBody(itemOverrides = {}) {
  return {
    clientRequestId: "11111111-1111-4111-8111-111111111111",
    customerName: "Walk-in",
    items: [{ productId: 1, quantity: 1, ...itemOverrides }],
    payments: [{ paymentMethod: "CASH", amount: "99.00" }],
  };
}

test("validateSaleRequest accepts a price override with a reason", () => {
  const { data, errors } = validateSaleRequest(
    baseBody({ unitPrice: "99.00", priceOverrideReason: "Damaged edge" })
  );
  assert.deepEqual(errors, []);
  assert.equal(data.items[0].overrideUnitPriceCents, 9900n);
  assert.equal(data.items[0].priceOverrideReason, "Damaged edge");
});

test("validateSaleRequest rejects a price override without a reason", () => {
  const { errors } = validateSaleRequest(baseBody({ unitPrice: "99.00" }));
  assert.ok(errors.some((message) => /requires a reason/i.test(message)));
});

test("validateSaleRequest rejects a non-positive override price", () => {
  const { errors } = validateSaleRequest(
    baseBody({ unitPrice: "0.00", priceOverrideReason: "Free sample" })
  );
  assert.ok(errors.some((message) => /override price is invalid/i.test(message)));
});

test("validateSaleRequest rejects an override reason over 300 characters", () => {
  const { errors } = validateSaleRequest(
    baseBody({ unitPrice: "99.00", priceOverrideReason: "x".repeat(301) })
  );
  assert.ok(errors.some((message) => /cannot exceed 300 characters/i.test(message)));
});

test("validateSaleRequest leaves overrideUnitPriceCents null when no override is sent", () => {
  const { data, errors } = validateSaleRequest(baseBody());
  assert.deepEqual(errors, []);
  assert.equal(data.items[0].overrideUnitPriceCents, null);
  assert.equal(data.items[0].priceOverrideReason, null);
});

test("createSale and updateSale apply the override price instead of the catalogue price", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "controllers", "saleController.js"),
    "utf8"
  );
  const occurrences = source.match(/item\.unitPriceCents = item\.overrideUnitPriceCents \?\? saleUnitPriceCents\(product, pricesByProduct\);/g) || [];
  assert.equal(occurrences.length, 2, "expected the override fallback in both createSale and updateSale");
});

test("sale item persistence stores the price override reason", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "controllers", "saleController.js"),
    "utf8"
  );
  const occurrences = source.match(/priceOverrideReason: item\.priceOverrideReason,/g) || [];
  assert.equal(occurrences.length, 2, "expected saleItem.create to persist the reason in both createSale and updateSale");
});

test("a sale with an override is flagged distinctly in the audit log", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "controllers", "saleController.js"),
    "utf8"
  );
  assert.match(source, /CREATE_SALE_WITH_PRICE_OVERRIDE/);
  assert.match(source, /UPDATE_SALE_WITH_PRICE_OVERRIDE/);
});

test("sale_items schema carries the price override reason column", () => {
  const schema = fs.readFileSync(
    path.join(__dirname, "..", "prisma", "schema.prisma"),
    "utf8"
  );
  assert.match(schema, /priceOverrideReason\s+String\?\s+@map\("price_override_reason"\)/);
});

test("discount and price list creation are open to cashiers, matching sale creation", () => {
  const discountRoutes = fs.readFileSync(
    path.join(__dirname, "..", "src", "routes", "discountRoutes.js"),
    "utf8"
  );
  assert.match(discountRoutes, /router\.post\("\/", authorizeRoles\("ADMIN", "CASHIER"\), createDiscount\)/);
  assert.match(discountRoutes, /router\.patch\("\/:id", authorizeRoles\("ADMIN", "CASHIER"\), updateDiscount\)/);

  const priceListRoutes = fs.readFileSync(
    path.join(__dirname, "..", "src", "routes", "priceListRoutes.js"),
    "utf8"
  );
  assert.match(priceListRoutes, /router\.post\("\/", authorizeRoles\("ADMIN", "CASHIER"\), createPriceList\)/);
  assert.match(priceListRoutes, /router\.patch\("\/:id", authorizeRoles\("ADMIN", "CASHIER"\), updatePriceList\)/);
});
