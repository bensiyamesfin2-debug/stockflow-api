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
const { sendCsv, parseDate } = require("../src/controllers/exportController");
const { buildProfessionalWorkbook } = require("../src/utils/professionalWorkbook");
const {
  validateSaleRequest,
  sumQuantityByProduct,
} = require("../src/controllers/saleController");
const {
  MEASUREMENTS,
  PRODUCT_FAMILIES,
  buildTrialProducts,
} = require("../src/scripts/setupSayinTrial");

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

test("live sales summaries are available to administrators and cashiers", () => {
  const routes = fs.readFileSync(
    path.join(__dirname, "..", "src", "routes", "reportRoutes.js"),
    "utf8"
  );
  assert.match(routes, /"\/sales-summary"/);
  assert.match(routes, /authorizeRoles\("ADMIN", "CASHIER"\)/);
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

test("exports preserve an exact selected timestamp", () => {
  assert.equal(
    parseDate("2026-07-29T12:45:00.000Z").toISOString(),
    "2026-07-29T12:45:00.000Z"
  );
});

test("professional workbook separates ledgers and preserves payment destinations", async () => {
  const product = { id: 1, sku: "603-100-20-2", name: "603", length: 100, width: 20, thickness: 2, costPrice: "600.00", sellingPrice: "900.00", isActive: true, createdAt: new Date("2026-08-01T08:00:00Z"), category: { name: "Granite" }, inventory: { reorderLevel: 3 } };
  const sales = [{
    id: 1,
    saleNumber: "SALE-20260812-TEST",
    status: "COMPLETED",
    customerName: "Walk-in",
    totalAmount: "1800.00",
    discountAmount: "0.00",
    creditBalance: "0.00",
    creditDueAt: null,
    createdAt: new Date("2026-08-12T09:30:00Z"),
    customer: null,
    cashier: { fullName: "Test Cashier", username: "cashier" },
    discount: null,
    items: [{ quantity: 2, releasedQuantity: 2, unitPrice: "900.00", customLength: null, customWidth: null, customThickness: null, product }],
    payments: [{ paymentMethod: "BANK_TRANSFER", status: "COMPLETED", bankName: "Commercial Bank", recipientAccount: "1000123456789", transactionReference: "TX-100", amount: "1800.00", createdAt: new Date("2026-08-12T09:35:00Z"), recordedBy: { fullName: "Test Cashier" } }],
  }];
  const inventory = [{ quantity: 12, reservedQuantity: 0, reorderLevel: 3, updatedAt: new Date("2026-08-12T09:00:00Z"), product }];
  const workbook = buildProfessionalWorkbook({ sales, inventory, products: [product], generatedAt: new Date("2026-08-12T10:00:00Z") });

  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ["Executive Summary", "Sales Ledger", "Sale Items", "Payments", "Inventory", "Products"]);
  assert.equal(workbook.getWorksheet("Payments").getCell("F2").value, "Commercial Bank");
  assert.equal(workbook.getWorksheet("Payments").getCell("G2").value, "1000123456789");
  assert.match(workbook.getWorksheet("Payments").getCell("I2").numFmt, /ETB/);
  assert.equal(workbook.getWorksheet("Executive Summary").getCell("A1").value, "BENSIYA PLC · STOCKFLOW");
  const buffer = await workbook.xlsx.writeBuffer();
  assert.equal(Buffer.from(buffer).subarray(0, 2).toString(), "PK");
});

test("Sayin's trial catalogue keeps all supplied granite families and measurements", () => {
  assert.deepEqual(PRODUCT_FAMILIES, [
    "603",
    "664",
    "602",
    "Spray White",
    "664 Old",
    "Black Galaxy",
    "River Black",
    "Tiger Skin",
  ]);
  assert.equal(MEASUREMENTS.length, 66);

  const products = buildTrialProducts(1);
  assert.equal(products.length, 528);
  assert.equal(new Set(products.map((product) => product.sku)).size, 528);
  assert.ok(products.every((product) => product.sellingPrice === "0.00"));
});

test("one order can contain several custom cuts from the same stock item", () => {
  const result = validateSaleRequest({
    clientRequestId: "d4f84dc2-9f0c-4d2f-96a0-523bc30a102e",
    items: [
      {
        productId: 12,
        quantity: 1,
        customMeasurement: { length: 100, width: 30, thickness: 3, pieces: 2 },
      },
      {
        productId: 12,
        quantity: 2,
        customMeasurement: { length: 80, width: 30, thickness: 3, pieces: 5 },
      },
    ],
    payments: [{ paymentMethod: "CASH", amount: "1.00" }],
  });

  assert.deepEqual(result.errors, []);
  assert.equal(result.data.items.length, 2);
  assert.equal(sumQuantityByProduct(result.data.items).get(12), 3);
});

test("multiple custom cuts use a non-unique sale-item product relation and preserve cancellation", () => {
  const schema = fs.readFileSync(
    path.join(__dirname, "..", "prisma", "schema.prisma"),
    "utf8"
  );
  const migration = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "prisma",
      "migrations",
      "20260729170000_allow_multiple_custom_cuts_per_product",
      "migration.sql"
    ),
    "utf8"
  );
  const saleRoutes = fs.readFileSync(
    path.join(__dirname, "..", "src", "routes", "saleRoutes.js"),
    "utf8"
  );

  assert.doesNotMatch(schema, /@@unique\(\[saleId, productId\]\)/);
  assert.match(migration, /DROP INDEX IF EXISTS "sale_items_sale_id_product_id_key"/);
  assert.match(saleRoutes, /"\/:id\/cancel"/);
});

test("warehouse operations persist locations, batches, delivery proof, and credit controls", () => {
  const schema = fs.readFileSync(path.join(__dirname, "..", "prisma", "schema.prisma"), "utf8");
  const inventoryRoutes = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "inventoryRoutes.js"), "utf8");
  const releaseRoutes = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "releaseRoutes.js"), "utf8");
  const saleRoutes = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "saleRoutes.js"), "utf8");

  for (const model of ["InventoryLocation", "InventoryLocationBalance", "StockBatch", "DeliveryProof"]) {
    assert.match(schema, new RegExp(`model ${model} \\{`));
  }
  assert.match(schema, /creditBalance/);
  assert.match(inventoryRoutes, /"\/locations"/);
  assert.match(inventoryRoutes, /"\/batches"/);
  assert.match(inventoryRoutes, /"\/adjustments"/);
  assert.match(inventoryRoutes, /"\/audit"/);
  assert.match(releaseRoutes, /"\/:id\/delivery-proof"/);
  assert.match(saleRoutes, /"\/:id\/payments"/);

  const creditSale = validateSaleRequest({
    clientRequestId: "b4f84dc2-9f0c-4d2f-96a0-523bc30a102e",
    customerId: 7,
    allowCredit: true,
    creditDueAt: "2026-09-01T12:00:00.000Z",
    items: [{ productId: 12, quantity: 1 }],
    payments: [],
  });
  assert.deepEqual(creditSale.errors, []);
  assert.equal(creditSale.data.allowCredit, true);
});

test("non-cash payments retain their recipient account for dashboards and exports", () => {
  const missingAccount = validateSaleRequest({
    items: [{ productId: 12, quantity: 1 }],
    payments: [{
      paymentMethod: "BANK_TRANSFER",
      amount: "2500.00",
      bankName: "Commercial Bank",
      transactionReference: "TX-100",
    }],
  });
  assert.match(missingAccount.errors.join(" "), /recipient account/i);

  const validPayment = validateSaleRequest({
    items: [{ productId: 12, quantity: 1 }],
    payments: [{
      paymentMethod: "BANK_TRANSFER",
      amount: "2500.00",
      bankName: "Commercial Bank",
      recipientAccount: "1000123456789",
      transactionReference: "TX-100",
    }],
  });
  assert.deepEqual(validPayment.errors, []);
  assert.equal(validPayment.data.payments[0].recipientAccount, "1000123456789");

  const schema = fs.readFileSync(path.join(__dirname, "..", "prisma", "schema.prisma"), "utf8");
  const exportController = fs.readFileSync(path.join(__dirname, "..", "src", "controllers", "exportController.js"), "utf8");
  assert.match(schema, /recipientAccount\s+String\?/);
  assert.match(exportController, /title: "Recipient Account"/);
  assert.match(exportController, /title: "Payment Destination"/);
});
