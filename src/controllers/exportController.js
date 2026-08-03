const { createObjectCsvStringifier } = require("csv-writer");
const prisma = require("../config/prisma");

function parseDate(value, endOfDay = false) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    date.setUTCHours(endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
  }
  return date;
}

function dateWhere(req, res, field = "createdAt") {
  const from = parseDate(req.query.from);
  const to = parseDate(req.query.to, true);
  if (from === null || to === null || (from && to && from > to)) {
    res.status(400).json({ success: false, message: "Invalid export date range" });
    return null;
  }
  return from || to ? { [field]: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {};
}

function sendCsv(res, filename, header, rows) {
  const writer = createObjectCsvStringifier({ header });
  const csv = `\uFEFF${writer.getHeaderString()}${writer.stringifyRecords(rows)}`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  return res.send(csv);
}

async function findAllSales(args, batchSize = 1000) {
  const sales = [];
  let cursor;

  while (true) {
    const batch = await prisma.sale.findMany({
      ...args,
      orderBy: { id: "asc" },
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    sales.push(...batch);
    if (batch.length < batchSize) return sales;
    cursor = batch.at(-1).id;
  }
}

async function exportSales(req, res) {
  const where = dateWhere(req, res);
  if (where === null) return;
  const sales = await findAllSales({
    where,
    include: {
      customer: { select: { id: true, name: true, phone: true } },
      discount: { select: { code: true } },
      cashier: { select: { fullName: true, username: true } },
      items: { include: { product: true } },
      payments: true,
    },
  });
  const rows = sales.flatMap((sale) => sale.items.map((item) => ({
    saleNumber: sale.saleNumber,
    date: sale.createdAt.toISOString(),
    status: sale.status,
    customer: sale.customer?.name || sale.customerName || "",
    customerPhone: sale.customer?.phone || "",
    cashier: sale.cashier.fullName,
    username: sale.cashier.username,
    product: item.product.name,
    sku: item.product.sku,
    measurement: [item.customLength || item.product.length, item.customWidth || item.product.width, item.customThickness || item.product.thickness].filter((value) => value !== null).join("x"),
    quantity: item.quantity,
    releasedQuantity: item.releasedQuantity,
    unitPrice: item.unitPrice.toFixed(2),
    lineTotal: (Number(item.unitPrice) * item.quantity).toFixed(2),
    discountCode: sale.discount?.code || "",
    discountAmount: sale.discountAmount.toFixed(2),
    saleTotal: sale.totalAmount.toFixed(2),
    paymentMethods: [...new Set(sale.payments.filter((payment) => payment.status === "COMPLETED").map((payment) => payment.paymentMethod))].join(" + "),
  })));
  return sendCsv(res, `stockflow-sales-${new Date().toISOString().slice(0, 10)}.csv`, [
    { id: "saleNumber", title: "Sale Number" },
    { id: "date", title: "Date" },
    { id: "status", title: "Status" },
    { id: "customer", title: "Customer" },
    { id: "customerPhone", title: "Customer Phone" },
    { id: "cashier", title: "Cashier" },
    { id: "username", title: "Cashier Username" },
    { id: "product", title: "Product" },
    { id: "sku", title: "Internal SKU" },
    { id: "measurement", title: "Measurement" },
    { id: "quantity", title: "Quantity" },
    { id: "releasedQuantity", title: "Released Quantity" },
    { id: "unitPrice", title: "Unit Price" },
    { id: "lineTotal", title: "Line Total" },
    { id: "discountCode", title: "Discount Code" },
    { id: "discountAmount", title: "Sale Discount" },
    { id: "saleTotal", title: "Sale Total" },
    { id: "paymentMethods", title: "Payment Methods" },
  ], rows);
}

async function exportInventory(req, res) {
  const where = dateWhere(req, res, "updatedAt");
  if (where === null) return;
  const records = await prisma.inventory.findMany({
    where,
    include: { product: { include: { category: true } } },
    orderBy: { product: { name: "asc" } },
  });
  const rows = records.map((record) => ({
    sku: record.product.sku,
    product: record.product.name,
    category: record.product.category?.name || "",
    measurement: [record.product.length, record.product.width, record.product.thickness].filter((value) => value !== null).join("x"),
    active: record.product.isActive ? "Yes" : "No",
    quantity: record.quantity,
    reserved: record.reservedQuantity,
    available: record.quantity - record.reservedQuantity,
    reorderLevel: record.reorderLevel,
    costPrice: record.product.costPrice?.toFixed(2) || "",
    sellingPrice: record.product.sellingPrice.toFixed(2),
    updatedAt: record.updatedAt.toISOString(),
  }));
  return sendCsv(res, `stockflow-inventory-${new Date().toISOString().slice(0, 10)}.csv`, [
    { id: "sku", title: "Internal SKU" },
    { id: "product", title: "Product" },
    { id: "category", title: "Category" },
    { id: "measurement", title: "Measurement" },
    { id: "active", title: "Active" },
    { id: "quantity", title: "Physical Quantity" },
    { id: "reserved", title: "Reserved Quantity" },
    { id: "available", title: "Available Quantity" },
    { id: "reorderLevel", title: "Reorder Level" },
    { id: "costPrice", title: "Cost Price" },
    { id: "sellingPrice", title: "Selling Price" },
    { id: "updatedAt", title: "Updated At" },
  ], rows);
}

async function exportProducts(req, res) {
  const where = dateWhere(req, res);
  if (where === null) return;
  const products = await prisma.product.findMany({
    where,
    include: { category: true, inventory: true },
    orderBy: [{ name: "asc" }, { thickness: "desc" }, { width: "desc" }, { length: "desc" }],
  });
  const rows = products.map((product) => ({
    sku: product.sku,
    name: product.name,
    category: product.category?.name || "",
    length: product.length ?? "",
    width: product.width ?? "",
    thickness: product.thickness ?? "",
    sellingPrice: product.sellingPrice.toFixed(2),
    costPrice: product.costPrice?.toFixed(2) || "",
    reorderLevel: product.inventory?.reorderLevel ?? "",
    active: product.isActive ? "Yes" : "No",
    createdAt: product.createdAt.toISOString(),
  }));
  return sendCsv(res, `stockflow-products-${new Date().toISOString().slice(0, 10)}.csv`, [
    { id: "sku", title: "Internal SKU" },
    { id: "name", title: "Product" },
    { id: "category", title: "Category" },
    { id: "length", title: "Length" },
    { id: "width", title: "Width" },
    { id: "thickness", title: "Thickness" },
    { id: "sellingPrice", title: "Selling Price" },
    { id: "costPrice", title: "Cost Price" },
    { id: "reorderLevel", title: "Reorder Level" },
    { id: "active", title: "Active" },
    { id: "createdAt", title: "Created At" },
  ], rows);
}

module.exports = { exportSales, exportInventory, exportProducts, sendCsv, parseDate };
