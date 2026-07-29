const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
process.env.DATABASE_URL ||= "postgresql://postgres:postgres@127.0.0.1:5432/stockflow_test";
const { normalizeCategory } = require("../src/controllers/categoryController");
const { normalizeSupplier } = require("../src/controllers/supplierController");
const { normalizeCustomer } = require("../src/controllers/customerController");
const { normalizePurchaseOrder } = require("../src/controllers/purchaseOrderController");
const { normalizeCountedItems } = require("../src/controllers/stockCountController");
const { normalizeDiscount } = require("../src/controllers/discountController");
const { calculateDiscountCents } = require("../src/utils/discounts");
const { centsToMoney } = require("../src/utils/money");
const { sendCsv } = require("../src/controllers/exportController");

test("operations schema contains every new model and relation target", () => {
  const schema = fs.readFileSync(
    path.join(__dirname, "..", "prisma", "schema.prisma"),
    "utf8"
  );
  for (const model of [
    "Category",
    "Supplier",
    "Customer",
    "PurchaseOrder",
    "PurchaseOrderItem",
    "StockCount",
    "StockCountItem",
    "Discount",
    "Shift",
  ]) {
    assert.match(schema, new RegExp(`model ${model} \\{`));
  }
});

test("every operations route is mounted in app.js", () => {
  const app = fs.readFileSync(
    path.join(__dirname, "..", "src", "app.js"),
    "utf8"
  );
  for (const [route, variable] of [
    ["/api/categories", "categoryRoutes"],
    ["/api/suppliers", "supplierRoutes"],
    ["/api/customers", "customerRoutes"],
    ["/api/purchase-orders", "purchaseOrderRoutes"],
    ["/api/stock-counts", "stockCountRoutes"],
    ["/api/discounts", "discountRoutes"],
    ["/api/shifts", "shiftRoutes"],
    ["/api/exports", "exportRoutes"],
    ["/api/reports", "reportRoutes"],
  ]) {
    assert.match(
      app,
      new RegExp(`app\\.use\\("${route}",\\s*${variable}\\)`)
    );
  }
});

test("category, supplier, and customer inputs are normalized and bounded", () => {
  assert.deepEqual(normalizeCategory({ name: "  Natural   Stone " }).data, {
    name: "Natural Stone",
  });
  assert.equal(normalizeSupplier({
    name: "Sayin Importer",
    email: "not-an-email",
  }).errors[0], "Email address is invalid");
  assert.deepEqual(normalizeCustomer({
    name: "  Abebe   Kebede ",
    phone: "+251911000000",
  }).data, {
    name: "Abebe Kebede",
    phone: "+251911000000",
  });
});

test("purchase orders reject duplicate products and invalid costs", () => {
  const normalized = normalizePurchaseOrder({
    supplierId: 1,
    status: "ordered",
    items: [
      { productId: 2, quantity: 5, unitCost: "100.00" },
      { productId: 2, quantity: 1, unitCost: "invalid" },
    ],
  });
  assert.match(normalized.errors.join(" "), /appears more than once/);
  assert.match(normalized.errors.join(" "), /invalid unit cost/);
});

test("stock counts accept zero physical stock but not negative values", () => {
  assert.deepEqual(
    normalizeCountedItems([{ productId: 1, countedQuantity: 0 }]),
    { items: [{ productId: 1, countedQuantity: 0 }], errors: [] }
  );
  assert.match(
    normalizeCountedItems([{ productId: 1, countedQuantity: -1 }]).errors[0],
    /non-negative/
  );
});

test("percentage and fixed discounts calculate in integer cents", () => {
  const base = {
    isActive: true,
    startsAt: null,
    endsAt: null,
    usageLimit: null,
    usageCount: 0,
    minimumAmount: null,
    maximumDiscount: null,
  };
  assert.equal(
    calculateDiscountCents(
      { ...base, type: "PERCENTAGE", value: "12.50" },
      10_000n
    ),
    1_250n
  );
  assert.equal(
    calculateDiscountCents(
      { ...base, type: "FIXED", value: "500.00" },
      20_000n
    ),
    20_000n
  );
  assert.equal(centsToMoney(-125n), "-1.25");
});

test("discount validation limits percentages to 100", () => {
  const result = normalizeDiscount({
    code: "opening",
    name: "Opening offer",
    type: "percentage",
    value: "101",
  });
  assert.match(result.errors.join(" "), /cannot exceed 100/);
});

test("CSV exports include a BOM, headers, and quoted unsafe values", () => {
  const headers = {};
  let body;
  const response = {
    setHeader(name, value) {
      headers[name.toLowerCase()] = value;
    },
    send(value) {
      body = value;
      return value;
    },
  };
  sendCsv(
    response,
    "test.csv",
    [{ id: "name", title: "Name" }],
    [{ name: 'Galaxy, "Premium"' }]
  );
  assert.equal(headers["content-type"], "text/csv; charset=utf-8");
  assert.match(headers["content-disposition"], /test\.csv/);
  assert.ok(body.startsWith("\uFEFFName"));
  assert.match(body, /"Galaxy, ""Premium"""/);
});
