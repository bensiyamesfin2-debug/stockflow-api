const ExcelJS = require("exceljs");
const prisma = require("../config/prisma");
const { moneyToCents, centsToMoney } = require("../utils/money");
const { cellText, normalizeImportHeader } = require("../utils/excelCells");
const { normalizeProductName } = require("../utils/productCatalog");

const PAYMENT_METHODS = new Set(["CASH", "BANK_TRANSFER", "MOBILE_MONEY", "CARD"]);
const ROW_TYPES = new Set(["SALE", "PAYMENT"]);

const IMPORT_HEADERS = {
  rowType: ["row type", "type"],
  date: ["date"],
  customer: ["customer name", "customer"],
  product: ["product name", "product"],
  length: ["length cm", "length"],
  width: ["width cm", "width"],
  thickness: ["thickness cm", "thickness"],
  quantity: ["quantity"],
  unitPrice: ["unit price etb", "unit price"],
  amount: ["amount etb", "amount", "payment amount"],
  paymentMethod: ["payment method"],
  note: ["note", "notes"],
};

function findImportColumn(headerMap, field) {
  return IMPORT_HEADERS[field].map((alias) => headerMap.get(alias)).find(Boolean);
}

function parseRowDate(text) {
  if (!text) return null;
  const trimmed = text.trim();
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (match) {
    const [, y, m, d] = match;
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (match) {
    const [, d, m, y] = match;
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const fallback = new Date(trimmed);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function makeHistoricalSaleNumber(index) {
  return `HIST-${Date.now().toString(36).toUpperCase()}-${index}`;
}

// Applies a payment to a customer's open (unpaid) sales, oldest first -- like real accounts
// receivable. Mutates each sale's `remainingCents`. Returns the per-sale amounts applied (for
// creating Payment rows) and whatever part of the payment could not be applied to any sale.
function applyFifoPayment(openSales, amountCents) {
  let remaining = amountCents;
  const applications = [];
  for (const sale of openSales) {
    if (remaining <= 0n) break;
    if (sale.remainingCents <= 0n) continue;
    const applied = sale.remainingCents < remaining ? sale.remainingCents : remaining;
    sale.remainingCents -= applied;
    remaining -= applied;
    applications.push({ sale, appliedCents: applied });
  }
  return { applications, unappliedCents: remaining };
}

async function parseHistoricalSaleWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    return { rows: [], errors: ["The file is not a readable .xlsx workbook"] };
  }
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return { rows: [], errors: ["The workbook does not contain a worksheet"] };

  const headerMap = new Map();
  worksheet.getRow(1).eachCell((cell, column) => headerMap.set(normalizeImportHeader(cellText(cell)), column));
  const columns = Object.fromEntries(Object.keys(IMPORT_HEADERS).map((field) => [field, findImportColumn(headerMap, field)]));
  const errors = [];
  if (!columns.rowType) errors.push("The first row needs a Row Type column (Sale or Payment)");
  if (!columns.date) errors.push("The first row needs a Date column");
  if (!columns.customer) errors.push("The first row needs a Customer Name column");
  if (errors.length) return { rows: [], errors };

  const rows = [];
  const lastRow = Math.min(worksheet.actualRowCount, 20001);
  for (let rowNumber = 2; rowNumber <= lastRow; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const rowTypeText = cellText(row.getCell(columns.rowType)).trim().toUpperCase();
    const dateText = cellText(row.getCell(columns.date));
    const customerText = cellText(row.getCell(columns.customer)).trim().replace(/\s+/g, " ");
    const rawValues = [rowTypeText, dateText, customerText];
    if (rawValues.every((value) => !value)) continue;

    if (!ROW_TYPES.has(rowTypeText)) {
      errors.push(`Row ${rowNumber}: Row Type must be "Sale" or "Payment"`);
      continue;
    }
    const date = parseRowDate(dateText);
    if (!date) {
      errors.push(`Row ${rowNumber}: Date is missing or unreadable`);
      continue;
    }
    if (customerText.length < 2 || customerText.length > 150) {
      errors.push(`Row ${rowNumber}: Customer Name must be between 2 and 150 characters`);
      continue;
    }
    const note = columns.note ? cellText(row.getCell(columns.note)) || null : null;

    if (rowTypeText === "SALE") {
      const nameInput = columns.product ? cellText(row.getCell(columns.product)) : "";
      const normalizedName = normalizeProductName(nameInput);
      const length = Number(columns.length ? cellText(row.getCell(columns.length)) : "");
      const width = Number(columns.width ? cellText(row.getCell(columns.width)) : "");
      const thickness = Number(columns.thickness ? cellText(row.getCell(columns.thickness)) : "");
      const quantity = Number(columns.quantity ? cellText(row.getCell(columns.quantity)) : "");
      const unitPriceCents = moneyToCents(columns.unitPrice ? cellText(row.getCell(columns.unitPrice)) : "");
      if (normalizedName.error) errors.push(`Row ${rowNumber}: ${normalizedName.error}`);
      if (!Number.isInteger(length) || length <= 0 || !Number.isInteger(width) || width <= 0 || !Number.isInteger(thickness) || thickness <= 0) {
        errors.push(`Row ${rowNumber}: Length, Width, and Thickness must be positive whole numbers`);
      }
      if (!Number.isInteger(quantity) || quantity <= 0) errors.push(`Row ${rowNumber}: Quantity must be a positive whole number`);
      if (unitPriceCents === null || unitPriceCents < 0n) errors.push(`Row ${rowNumber}: Unit Price must be a non-negative amount`);
      if (normalizedName.error || !Number.isInteger(length) || length <= 0 || !Number.isInteger(width) || width <= 0 || !Number.isInteger(thickness) || thickness <= 0 || !Number.isInteger(quantity) || quantity <= 0 || unitPriceCents === null || unitPriceCents < 0n) continue;
      rows.push({
        rowNumber, type: "SALE", date, customer: customerText, note,
        productName: normalizedName.name, length, width, thickness, quantity,
        unitPriceCents, totalCents: unitPriceCents * BigInt(quantity),
      });
    } else {
      const amountCents = moneyToCents(columns.amount ? cellText(row.getCell(columns.amount)) : "");
      const methodText = columns.paymentMethod ? cellText(row.getCell(columns.paymentMethod)).trim().toUpperCase().replace(/\s+/g, "_") : "CASH";
      const paymentMethod = methodText || "CASH";
      if (amountCents === null || amountCents <= 0n) errors.push(`Row ${rowNumber}: Amount must be a positive amount`);
      if (!PAYMENT_METHODS.has(paymentMethod)) errors.push(`Row ${rowNumber}: Payment Method must be one of Cash, Bank Transfer, Mobile Money, Card`);
      if (amountCents === null || amountCents <= 0n || !PAYMENT_METHODS.has(paymentMethod)) continue;
      rows.push({ rowNumber, type: "PAYMENT", date, customer: customerText, note, amountCents, paymentMethod });
    }
  }
  if (worksheet.actualRowCount > 20001) errors.push("The workbook exceeds the 20,000 row limit");
  if (!rows.length && !errors.length) errors.push("The workbook does not contain any sale or payment rows");
  return { rows, errors };
}

async function historicalSaleImportPlan(buffer) {
  const parsed = await parseHistoricalSaleWorkbook(buffer);
  if (parsed.errors.length) return { ...parsed, plan: null };

  const saleRows = parsed.rows.filter((row) => row.type === "SALE");
  const productKeys = [...new Map(saleRows.map((row) => [`${row.productName}||${row.length}||${row.width}||${row.thickness}`, row])).values()];
  const products = productKeys.length
    ? await prisma.product.findMany({
        where: { OR: productKeys.map((row) => ({ name: row.productName, length: row.length, width: row.width, thickness: row.thickness })) },
        select: { id: true, name: true, length: true, width: true, thickness: true },
      })
    : [];
  const productByKey = new Map(products.map((product) => [`${product.name}||${product.length}||${product.width}||${product.thickness}`, product]));

  for (const row of saleRows) {
    const key = `${row.productName}||${row.length}||${row.width}||${row.thickness}`;
    if (!productByKey.has(key)) {
      parsed.errors.push(`Row ${row.rowNumber}: no product "${row.productName}" at ${row.length}x${row.width}x${row.thickness} exists yet -- import the product catalogue first`);
    }
  }
  if (parsed.errors.length) return { ...parsed, plan: null };

  const customerNames = [...new Set(parsed.rows.map((row) => row.customer))];
  const existingCustomers = await prisma.customer.findMany({
    where: { OR: customerNames.map((name) => ({ name: { equals: name, mode: "insensitive" } })) },
  });
  const customerByLowerName = new Map(existingCustomers.map((customer) => [customer.name.toLowerCase(), customer]));
  const customersToCreate = customerNames.filter((name) => !customerByLowerName.has(name.toLowerCase()));

  const byCustomer = new Map();
  for (const row of parsed.rows) {
    const key = row.customer.toLowerCase();
    if (!byCustomer.has(key)) byCustomer.set(key, []);
    byCustomer.get(key).push(row);
  }

  const unappliedPayments = [];
  let totalSalesCents = 0n;
  let totalPaymentsCents = 0n;
  let appliedPaymentsCents = 0n;
  for (const [, customerRows] of byCustomer) {
    const openSales = [];
    for (const row of customerRows) {
      if (row.type === "SALE") {
        totalSalesCents += row.totalCents;
        openSales.push({ remainingCents: row.totalCents });
      } else {
        totalPaymentsCents += row.amountCents;
        const { applications, unappliedCents } = applyFifoPayment(openSales, row.amountCents);
        appliedPaymentsCents += applications.reduce((sum, application) => sum + application.appliedCents, 0n);
        if (unappliedCents > 0n) {
          unappliedPayments.push({ rowNumber: row.rowNumber, customer: row.customer, date: row.date, amount: centsToMoney(unappliedCents) });
        }
      }
    }
  }

  return {
    ...parsed,
    plan: {
      customersToCreate,
      customersMatched: customerNames.length - customersToCreate.length,
      salesToCreate: saleRows.length,
      paymentRows: parsed.rows.filter((row) => row.type === "PAYMENT").length,
      totalSales: centsToMoney(totalSalesCents),
      totalPayments: centsToMoney(totalPaymentsCents),
      appliedPayments: centsToMoney(appliedPaymentsCents),
      unappliedPayments,
    },
    productByKey,
    customerByLowerName,
  };
}

async function previewHistoricalSaleImport(req, res) {
  const result = await historicalSaleImportPlan(req.body);
  return res.status(result.errors.length ? 400 : 200).json({
    success: result.errors.length === 0,
    message: result.errors.length ? "Fix the workbook errors before importing" : "Workbook validated and ready to import",
    errors: result.errors,
    data: { preview: result.plan },
  });
}

async function importHistoricalSales(req, res) {
  const result = await historicalSaleImportPlan(req.body);
  if (result.errors.length) return res.status(400).json({ success: false, message: "Fix the workbook errors before importing", errors: result.errors });

  const { rows, plan, productByKey, customerByLowerName } = result;
  const counts = await prisma.$transaction(async (transaction) => {
    for (const name of plan.customersToCreate) {
      const created = await transaction.customer.create({ data: { name } });
      customerByLowerName.set(name.toLowerCase(), created);
    }

    const byCustomer = new Map();
    for (const row of rows) {
      const key = row.customer.toLowerCase();
      if (!byCustomer.has(key)) byCustomer.set(key, []);
      byCustomer.get(key).push(row);
    }

    let salesCreated = 0;
    let paymentsCreated = 0;
    let rowIndex = 0;
    for (const [customerKey, customerRows] of byCustomer) {
      const customer = customerByLowerName.get(customerKey);
      const openSales = [];
      for (const row of customerRows) {
        rowIndex += 1;
        if (row.type === "SALE") {
          const product = productByKey.get(`${row.productName}||${row.length}||${row.width}||${row.thickness}`);
          const createdSale = await transaction.sale.create({
            data: {
              saleNumber: makeHistoricalSaleNumber(rowIndex),
              cashierId: req.user.id,
              customerId: customer.id,
              customerName: customer.name,
              totalAmount: centsToMoney(row.totalCents),
              creditBalance: centsToMoney(row.totalCents),
              status: "COMPLETED",
              createdAt: row.date,
              completedAt: row.date,
              items: {
                create: [{
                  productId: product.id,
                  quantity: row.quantity,
                  unitPrice: centsToMoney(row.unitPriceCents),
                  releasedQuantity: row.quantity,
                }],
              },
            },
          });
          salesCreated += 1;
          openSales.push({ saleId: createdSale.id, remainingCents: row.totalCents });
        } else {
          const { applications } = applyFifoPayment(openSales, row.amountCents);
          for (const { sale, appliedCents } of applications) {
            await transaction.payment.create({
              data: {
                saleId: sale.saleId,
                paymentMethod: row.paymentMethod,
                transactionReference: row.note ? row.note.slice(0, 150) : null,
                amount: centsToMoney(appliedCents),
                recordedById: req.user.id,
                createdAt: row.date,
              },
            });
            await transaction.sale.update({ where: { id: sale.saleId }, data: { creditBalance: centsToMoney(sale.remainingCents) } });
            paymentsCreated += 1;
          }
        }
      }
    }

    const summary = {
      customersCreated: plan.customersToCreate.length,
      customersMatched: plan.customersMatched,
      salesCreated,
      paymentsCreated,
      totalSales: plan.totalSales,
      totalPaymentsApplied: plan.appliedPayments,
      unappliedPayments: plan.unappliedPayments,
    };
    await transaction.auditLog.create({ data: { userId: req.user.id, action: "IMPORT_HISTORICAL_SALES", entityType: "SALE", details: summary } });
    return summary;
  }, { timeout: 60000 });

  return res.status(201).json({ success: true, message: `${counts.salesCreated} historical sales and ${counts.paymentsCreated} payments imported`, data: { counts } });
}

async function downloadHistoricalSaleImportTemplate(req, res) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "StockFlow";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet("Sales History", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = [
    { header: "Row Type", key: "rowType", width: 12 }, { header: "Date", key: "date", width: 14 },
    { header: "Customer Name", key: "customer", width: 24 }, { header: "Product Name", key: "product", width: 20 },
    { header: "Length (cm)", key: "length", width: 13 }, { header: "Width (cm)", key: "width", width: 13 },
    { header: "Thickness (cm)", key: "thickness", width: 15 }, { header: "Quantity", key: "quantity", width: 12 },
    { header: "Unit Price (ETB)", key: "unitPrice", width: 17 }, { header: "Amount (ETB)", key: "amount", width: 15 },
    { header: "Payment Method", key: "paymentMethod", width: 16 }, { header: "Note", key: "note", width: 30 },
  ];
  sheet.addRow({ rowType: "Sale", date: "2018-11-25", customer: "Ashebire", product: "602", length: 200, width: 50, thickness: 2, quantity: 4, unitPrice: 7700, note: "" });
  sheet.addRow({ rowType: "Payment", date: "2018-11-26", customer: "Ashebire", amount: 100000, paymentMethod: "Bank Transfer", note: "bensiya cbe" });
  sheet.getRow(1).eachCell((cell) => { cell.font = { bold: true, color: { argb: "FFFFFFFF" } }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF111111" } }; cell.alignment = { vertical: "middle" }; });
  sheet.getRow(1).height = 26;
  sheet.getColumn(9).numFmt = '#,##0.00 "ETB"';
  sheet.getColumn(10).numFmt = '#,##0.00 "ETB"';
  const instructions = workbook.addWorksheet("Instructions");
  instructions.columns = [{ width: 110 }];
  [
    "STOCKFLOW HISTORICAL SALES IMPORT",
    "One row per event. Row Type is 'Sale' (a credit sale to a customer) or 'Payment' (money received from a customer).",
    "Sale rows need Product Name, Length, Width, Thickness, Quantity, and Unit Price -- the product must already exist in the catalogue.",
    "Payment rows need Amount, and are applied to that customer's oldest unpaid sale first (like real accounts-receivable).",
    "A payment that exceeds everything the customer owes is left unapplied and reported back after import, rather than guessed at.",
    "Customers are matched by name (case-insensitive) and created automatically if new.",
    "This import does not change stock quantities -- it only records the historical sale and payment trail.",
  ].forEach((text) => instructions.addRow([text]));
  instructions.getCell("A1").font = { bold: true, size: 16 };
  instructions.getColumn(1).alignment = { wrapText: true, vertical: "top" };
  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="stockflow-historical-sales-import-template.xlsx"');
  return res.send(Buffer.from(buffer));
}

module.exports = {
  parseHistoricalSaleWorkbook,
  historicalSaleImportPlan,
  previewHistoricalSaleImport,
  importHistoricalSales,
  downloadHistoricalSaleImportTemplate,
  applyFifoPayment,
};
