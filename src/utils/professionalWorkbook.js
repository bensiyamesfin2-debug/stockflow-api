const ExcelJS = require("exceljs");

const BLACK = "FF111111";
const WHITE = "FFFFFFFF";
const LIGHT = "FFF2F2F2";
const MID = "FFD0D0D0";
const MUTED = "FF666666";
const DATE_FORMAT = "yyyy-mm-dd hh:mm";

function currencyFormat(currency) {
  const code = /^[A-Z]{3}$/.test(String(currency || "").toUpperCase())
    ? String(currency).toUpperCase()
    : "ETB";
  return `"${code}" #,##0.00;[Red]-"${code}" #,##0.00`;
}

function footerText(value) {
  return String(value || "StockFlow").replaceAll("&", "&&");
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function measurement(record) {
  return [record.length, record.width, record.thickness]
    .filter((value) => value !== null && value !== undefined && value !== "")
    .join(" × ");
}

function completedPayments(sale) {
  return (sale.payments || []).filter((payment) => payment.status === "COMPLETED");
}

function refundedPayments(sale) {
  return (sale.payments || []).filter((payment) => payment.status === "REFUNDED");
}

function paymentStatus(sale) {
  if (sale.status === "CANCELLED") return "VOIDED";
  const paid = completedPayments(sale).reduce((sum, payment) => sum + number(payment.amount), 0);
  const refunded = refundedPayments(sale).reduce((sum, payment) => sum + number(payment.amount), 0);
  const netPaid = Math.max(0, paid - refunded);
  const total = number(sale.totalAmount);
  if (netPaid <= 0) return "UNPAID";
  if (netPaid + .005 < total) return "PARTIAL";
  return refunded > 0 ? "PARTIALLY REFUNDED" : "PAID";
}

function styleDataSheet(worksheet, columns, rowCount, moneyFormat, companyName) {
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.autoFilter = { from: "A1", to: `${worksheet.getColumn(columns.length).letter}${Math.max(1, rowCount + 1)}` };
  worksheet.properties.defaultRowHeight = 20;
  worksheet.getRow(1).height = 28;
  worksheet.getRow(1).eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLACK } };
    cell.font = { color: { argb: WHITE }, bold: true, size: 10 };
    cell.alignment = { vertical: "middle", horizontal: "left" };
    cell.border = { bottom: { style: "medium", color: { argb: BLACK } } };
  });

  for (let rowIndex = 2; rowIndex <= rowCount + 1; rowIndex += 1) {
    const row = worksheet.getRow(rowIndex);
    row.eachCell((cell) => {
      if (rowIndex % 2 === 0) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFAFAFA" } };
      }
      cell.alignment = { vertical: "top", wrapText: true };
      cell.border = { bottom: { style: "hair", color: { argb: MID } } };
      cell.font = { color: { argb: BLACK }, size: 9 };
    });
  }

  columns.forEach((column, index) => {
    const target = worksheet.getColumn(index + 1);
    if (column.format === "money") target.numFmt = moneyFormat;
    if (column.format === "date") target.numFmt = DATE_FORMAT;
    if (column.format === "integer") target.numFmt = "#,##0";
    if (column.format === "text") target.numFmt = "@";
  });
  worksheet.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: .25, right: .25, top: .5, bottom: .5, header: .2, footer: .2 } };
  worksheet.headerFooter.oddFooter = `&L${footerText(companyName)} · StockFlow&CPage &P of &N&RConfidential`;
}

function addDataSheet(workbook, name, columns, rows, moneyFormat, companyName) {
  const worksheet = workbook.addWorksheet(name, { properties: { tabColor: { argb: BLACK } } });
  worksheet.columns = columns.map((column) => ({ header: column.header, key: column.key, width: column.width || 16 }));
  worksheet.addRows(rows);
  styleDataSheet(worksheet, columns, rows.length, moneyFormat, companyName);
  return worksheet;
}

function accountSummary(sales) {
  const accounts = new Map();
  sales.filter((sale) => sale.status !== "CANCELLED").forEach((sale) => {
    completedPayments(sale).forEach((payment) => {
      const bank = payment.bankName || "Other";
      const account = payment.recipientAccount || "Not recorded";
      const key = `${bank}\u0000${account}`;
      const current = accounts.get(key) || { bank, account, payments: 0, amount: 0 };
      current.payments += 1;
      current.amount += number(payment.amount);
      accounts.set(key, current);
    });
  });
  return [...accounts.values()].sort((left, right) => right.amount - left.amount);
}

function soldItemSummary(sales) {
  const items = new Map();
  sales.filter((sale) => sale.status !== "CANCELLED").forEach((sale) => {
    (sale.items || []).forEach((item) => {
      const itemMeasurement = measurement({
        length: item.customLength || item.product.length,
        width: item.customWidth || item.product.width,
        thickness: item.customThickness || item.product.thickness,
      });
      const key = `${item.product.id}\u0000${itemMeasurement}`;
      const current = items.get(key) || {
        itemType: item.product.category?.name || "Uncategorised",
        product: item.product.name,
        sku: item.product.sku,
        measurement: itemMeasurement,
        sales: 0,
        units: 0,
        released: 0,
        revenue: 0,
      };
      current.sales += 1;
      current.units += number(item.quantity);
      current.released += number(item.releasedQuantity);
      current.revenue += number(item.unitPrice) * number(item.quantity);
      items.set(key, current);
    });
  });
  return [...items.values()].map((item) => ({ ...item, averageUnitPrice: item.units ? item.revenue / item.units : 0 })).sort((left, right) => right.revenue - left.revenue);
}

function addSummarySheet(workbook, { sales, inventory, from, to, generatedAt, companyName, currency, moneyFormat }) {
  const worksheet = workbook.addWorksheet("Executive Summary", { properties: { tabColor: { argb: BLACK } } });
  worksheet.columns = [
    { width: 25 }, { width: 18 }, { width: 5 }, { width: 25 },
    { width: 18 }, { width: 5 }, { width: 25 }, { width: 18 },
  ];
  worksheet.mergeCells("A1:H1");
  worksheet.getCell("A1").value = `${companyName.toUpperCase()} · STOCKFLOW`;
  worksheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLACK } };
  worksheet.getCell("A1").font = { color: { argb: WHITE }, bold: true, size: 22 };
  worksheet.getCell("A1").alignment = { vertical: "middle", horizontal: "left" };
  worksheet.getRow(1).height = 42;
  worksheet.mergeCells("A2:H2");
  worksheet.getCell("A2").value = `Professional operations and finance export · Currency: ${currency}`;
  worksheet.getCell("A2").font = { color: { argb: MUTED }, italic: true, size: 11 };
  worksheet.getRow(2).height = 24;

  worksheet.getCell("A4").value = "REPORT PERIOD";
  worksheet.getCell("B4").value = from || to ? `${from ? new Date(from).toLocaleString("en-GB") : "Beginning"} — ${to ? new Date(to).toLocaleString("en-GB") : "Now"}` : "All recorded time";
  worksheet.mergeCells("B4:E4");
  worksheet.getCell("G4").value = "GENERATED";
  worksheet.getCell("H4").value = generatedAt;
  worksheet.getCell("H4").numFmt = DATE_FORMAT;
  ["A4", "G4"].forEach((address) => { worksheet.getCell(address).font = { bold: true, color: { argb: MUTED }, size: 9 }; });

  const validSales = sales.filter((sale) => sale.status !== "CANCELLED");
  const completed = validSales.flatMap(completedPayments);
  const refunds = validSales.flatMap(refundedPayments);
  const metrics = [
    ["Sales recorded", validSales.length, "integer"],
    ["Sale revenue", validSales.reduce((sum, sale) => sum + number(sale.totalAmount), 0), "money"],
    ["Payments collected", completed.reduce((sum, payment) => sum + number(payment.amount), 0), "money"],
    ["Refunds", refunds.reduce((sum, payment) => sum + number(payment.amount), 0), "money"],
    ["Outstanding credit", validSales.reduce((sum, sale) => sum + number(sale.creditBalance), 0), "money"],
    ["Physical stock", inventory.reduce((sum, record) => sum + record.quantity, 0), "integer"],
    ["Available stock", inventory.reduce((sum, record) => sum + record.quantity - record.reservedQuantity, 0), "integer"],
    ["Inventory cost value", inventory.reduce((sum, record) => sum + number(record.product.costPrice) * record.quantity, 0), "money"],
  ];

  worksheet.mergeCells("A6:H6");
  worksheet.getCell("A6").value = "EXECUTIVE TOTALS";
  worksheet.getCell("A6").fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT } };
  worksheet.getCell("A6").font = { bold: true, color: { argb: BLACK }, size: 10 };
  metrics.forEach(([label, value, format], index) => {
    const row = 8 + Math.floor(index / 4) * 3;
    const column = 1 + (index % 4) * 2;
    const labelCell = worksheet.getCell(row, column);
    const valueCell = worksheet.getCell(row + 1, column);
    worksheet.mergeCells(row, column, row, column + 1);
    worksheet.mergeCells(row + 1, column, row + 1, column + 1);
    labelCell.value = label;
    labelCell.font = { color: { argb: MUTED }, bold: true, size: 9 };
    valueCell.value = value;
    valueCell.font = { color: { argb: BLACK }, bold: true, size: 16 };
    if (format === "money") valueCell.numFmt = moneyFormat;
    if (format === "integer") valueCell.numFmt = "#,##0";
  });

  const accounts = accountSummary(sales);
  worksheet.mergeCells("A15:H15");
  worksheet.getCell("A15").value = "REVENUE RECEIVED BY ACCOUNT";
  worksheet.getCell("A15").fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLACK } };
  worksheet.getCell("A15").font = { color: { argb: WHITE }, bold: true, size: 10 };
  ["Bank / provider", "Recipient account", "Payments", "Amount received"].forEach((label, index) => {
    const cell = worksheet.getCell(16, index * 2 + 1);
    worksheet.mergeCells(16, index * 2 + 1, 16, index * 2 + 2);
    cell.value = label;
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT } };
    cell.font = { bold: true, color: { argb: BLACK }, size: 9 };
  });
  if (!accounts.length) {
    worksheet.mergeCells("A17:H17");
    worksheet.getCell("A17").value = "No recipient-account payments were recorded in this period.";
    worksheet.getCell("A17").font = { italic: true, color: { argb: MUTED } };
  } else {
    accounts.forEach((account, index) => {
      const row = 17 + index;
      const values = [account.bank, account.account, account.payments, account.amount];
      values.forEach((value, valueIndex) => {
        const column = valueIndex * 2 + 1;
        worksheet.mergeCells(row, column, row, column + 1);
        worksheet.getCell(row, column).value = value;
        worksheet.getCell(row, column).border = { bottom: { style: "hair", color: { argb: MID } } };
      });
      worksheet.getCell(row, 7).numFmt = moneyFormat;
      worksheet.getCell(row, 3).numFmt = "@";
    });
  }
  worksheet.views = [{ state: "frozen", ySplit: 2 }];
  worksheet.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 1 };
  worksheet.headerFooter.oddFooter = `&L${footerText(companyName)} · StockFlow&CPage &P of &N&RConfidential`;
}

function buildProfessionalWorkbook({ sales, inventory, products, from, to, generatedAt = new Date(), companyName = "Bensiya PLC", currency = "ETB" }) {
  const normalizedCompanyName = String(companyName || "Bensiya PLC").trim() || "Bensiya PLC";
  const normalizedCurrency = /^[A-Z]{3}$/.test(String(currency || "").toUpperCase()) ? String(currency).toUpperCase() : "ETB";
  const moneyFormat = currencyFormat(normalizedCurrency);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "StockFlow";
  workbook.lastModifiedBy = "StockFlow";
  workbook.created = generatedAt;
  workbook.modified = generatedAt;
  workbook.company = normalizedCompanyName;
  workbook.title = "StockFlow Professional Data Export";
  workbook.subject = "Sales, payments, inventory, and product records";
  workbook.category = "Operations and Finance";
  workbook.description = "A finance-ready operational workbook generated by StockFlow.";
  workbook.calcProperties.fullCalcOnLoad = true;

  addSummarySheet(workbook, { sales, inventory, from, to, generatedAt, companyName: normalizedCompanyName, currency: normalizedCurrency, moneyFormat });

  addDataSheet(workbook, "Sales Ledger", [
    { header: "Sale Number", key: "saleNumber", width: 25 },
    { header: "Date", key: "date", width: 20, format: "date" },
    { header: "Status", key: "status", width: 20 },
    { header: "Payment Status", key: "paymentStatus", width: 18 },
    { header: "Customer", key: "customer", width: 25 },
    { header: "Customer Phone", key: "customerPhone", width: 18 },
    { header: "Cashier", key: "cashier", width: 22 },
    { header: "Sale Total", key: "saleTotal", width: 16, format: "money" },
    { header: "Discount", key: "discount", width: 14, format: "money" },
    { header: "Collected", key: "collected", width: 16, format: "money" },
    { header: "Refunded", key: "refunded", width: 14, format: "money" },
    { header: "Credit Balance", key: "creditBalance", width: 16, format: "money" },
    { header: "Credit Due", key: "creditDue", width: 16, format: "date" },
  ], sales.map((sale) => ({
    saleNumber: sale.saleNumber,
    date: sale.createdAt,
    status: sale.status,
    paymentStatus: paymentStatus(sale),
    customer: sale.customer?.name || sale.customerName || "Walk-in customer",
    customerPhone: sale.customer?.phone || null,
    cashier: sale.cashier?.fullName || null,
    saleTotal: number(sale.totalAmount),
    discount: number(sale.discountAmount),
    collected: completedPayments(sale).reduce((sum, payment) => sum + number(payment.amount), 0),
    refunded: refundedPayments(sale).reduce((sum, payment) => sum + number(payment.amount), 0),
    creditBalance: number(sale.creditBalance),
    creditDue: sale.creditDueAt || null,
  })), moneyFormat, normalizedCompanyName);

  addDataSheet(workbook, "Sale Items", [
    { header: "Sale Number", key: "saleNumber", width: 25 },
    { header: "Date", key: "date", width: 20, format: "date" },
    { header: "Customer", key: "customer", width: 24 },
    { header: "Internal SKU", key: "sku", width: 22, format: "text" },
    { header: "Product", key: "product", width: 22, format: "text" },
    { header: "Item Type", key: "itemType", width: 20 },
    { header: "Measurement", key: "measurement", width: 18 },
    { header: "Quantity", key: "quantity", width: 12, format: "integer" },
    { header: "Released", key: "released", width: 12, format: "integer" },
    { header: "Pending", key: "pending", width: 12, format: "integer" },
    { header: "Unit Price", key: "unitPrice", width: 15, format: "money" },
    { header: "Line Total", key: "lineTotal", width: 15, format: "money" },
    { header: "Discount Code", key: "discountCode", width: 16 },
  ], sales.flatMap((sale) => sale.items.map((item) => ({
    saleNumber: sale.saleNumber,
    date: sale.createdAt,
    customer: sale.customer?.name || sale.customerName || "Walk-in customer",
    sku: item.product.sku,
    product: item.product.name,
    itemType: item.product.category?.name || "Uncategorised",
    measurement: measurement({ length: item.customLength || item.product.length, width: item.customWidth || item.product.width, thickness: item.customThickness || item.product.thickness }),
    quantity: item.quantity,
    released: item.releasedQuantity,
    pending: item.quantity - item.releasedQuantity,
    unitPrice: number(item.unitPrice),
    lineTotal: number(item.unitPrice) * item.quantity,
    discountCode: sale.discount?.code || null,
  }))), moneyFormat, normalizedCompanyName);

  addDataSheet(workbook, "Sold Items Summary", [
    { header: "Item Type", key: "itemType", width: 22 },
    { header: "Product", key: "product", width: 22, format: "text" },
    { header: "Internal SKU", key: "sku", width: 22, format: "text" },
    { header: "Measurement", key: "measurement", width: 18 },
    { header: "Sales", key: "sales", width: 12, format: "integer" },
    { header: "Units Sold", key: "units", width: 14, format: "integer" },
    { header: "Units Released", key: "released", width: 16, format: "integer" },
    { header: "Revenue", key: "revenue", width: 16, format: "money" },
    { header: "Average Unit Price", key: "averageUnitPrice", width: 18, format: "money" },
  ], soldItemSummary(sales), moneyFormat, normalizedCompanyName);

  addDataSheet(workbook, "Payments", [
    { header: "Payment Date", key: "date", width: 20, format: "date" },
    { header: "Sale Number", key: "saleNumber", width: 25 },
    { header: "Customer", key: "customer", width: 24 },
    { header: "Method", key: "method", width: 18 },
    { header: "Status", key: "status", width: 16 },
    { header: "Bank / Provider", key: "bank", width: 24 },
    { header: "Recipient Account", key: "account", width: 24, format: "text" },
    { header: "Transaction Reference", key: "reference", width: 24 },
    { header: "Amount", key: "amount", width: 16, format: "money" },
    { header: "Recorded By", key: "recordedBy", width: 22 },
  ], sales.flatMap((sale) => sale.payments.map((payment) => ({
    date: payment.createdAt,
    saleNumber: sale.saleNumber,
    customer: sale.customer?.name || sale.customerName || "Walk-in customer",
    method: payment.paymentMethod,
    status: payment.status,
    bank: payment.bankName || null,
    account: payment.recipientAccount || null,
    reference: payment.transactionReference || null,
    amount: number(payment.amount),
    recordedBy: payment.recordedBy?.fullName || null,
  }))), moneyFormat, normalizedCompanyName);

  addDataSheet(workbook, "Inventory", [
    { header: "Internal SKU", key: "sku", width: 24 },
    { header: "Product", key: "product", width: 22 },
    { header: "Category", key: "category", width: 20 },
    { header: "Measurement", key: "measurement", width: 18 },
    { header: "Physical", key: "physical", width: 12, format: "integer" },
    { header: "Reserved", key: "reserved", width: 12, format: "integer" },
    { header: "Available", key: "available", width: 12, format: "integer" },
    { header: "Reorder At", key: "reorder", width: 12, format: "integer" },
    { header: "Cost Price", key: "cost", width: 14, format: "money" },
    { header: "Selling Price", key: "selling", width: 14, format: "money" },
    { header: "Cost Value", key: "value", width: 16, format: "money" },
    { header: "Updated", key: "updated", width: 20, format: "date" },
  ], inventory.map((record) => ({
    sku: record.product.sku,
    product: record.product.name,
    category: record.product.category?.name || null,
    measurement: measurement(record.product),
    physical: record.quantity,
    reserved: record.reservedQuantity,
    available: record.quantity - record.reservedQuantity,
    reorder: record.reorderLevel,
    cost: number(record.product.costPrice),
    selling: number(record.product.sellingPrice),
    value: number(record.product.costPrice) * record.quantity,
    updated: record.updatedAt,
  })), moneyFormat, normalizedCompanyName);

  addDataSheet(workbook, "Products", [
    { header: "Internal SKU", key: "sku", width: 24 },
    { header: "Product", key: "product", width: 22 },
    { header: "Category", key: "category", width: 20 },
    { header: "Length", key: "length", width: 12 },
    { header: "Width", key: "width", width: 12 },
    { header: "Thickness", key: "thickness", width: 12 },
    { header: "Cost Price", key: "cost", width: 14, format: "money" },
    { header: "Selling Price", key: "selling", width: 14, format: "money" },
    { header: "Reorder At", key: "reorder", width: 12, format: "integer" },
    { header: "Active", key: "active", width: 12 },
    { header: "Created", key: "created", width: 20, format: "date" },
  ], products.map((product) => ({
    sku: product.sku,
    product: product.name,
    category: product.category?.name || null,
    length: product.length ?? null,
    width: product.width ?? null,
    thickness: product.thickness ?? null,
    cost: number(product.costPrice),
    selling: number(product.sellingPrice),
    reorder: product.inventory?.reorderLevel ?? null,
    active: product.isActive ? "Yes" : "No",
    created: product.createdAt,
  })), moneyFormat, normalizedCompanyName);

  return workbook;
}

module.exports = { buildProfessionalWorkbook, paymentStatus, accountSummary, soldItemSummary, currencyFormat };
