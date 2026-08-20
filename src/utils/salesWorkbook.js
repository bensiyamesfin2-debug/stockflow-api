const ExcelJS = require("exceljs");
const JSZip = require("jszip");

const HEADER_ALIASES = {
  date: ["date of sale", "sale date", "date"],
  customer: ["customer", "customer name", "client"],
  productType: ["product type", "type", "category"],
  product: ["material product", "material / product", "product", "material", "product sku", "sku"],
  length: ["length", "length cm", "l"],
  width: ["width", "width cm", "w"],
  thickness: ["thickness", "thickness cm", "t"],
  openingBalance: ["beginning balance", "opening balance", "opening inventory", "starting inventory"],
  quantity: ["quantity sold", "quantity of material sold", "quantity", "qty sold", "qty"],
  remainingInventory: ["remaining inventory", "remaining", "current inventory", "current balance"],
  unitPrice: ["selling price", "unit price", "price"],
  currentSellingPrice: ["current selling price", "latest selling price"],
  amount: ["total sales", "full sale value", "amount etb", "amount", "sale amount", "total amount", "total"],
  amountReceived: ["amount received", "paid amount", "received"],
  outstandingCredit: ["outstanding credit", "credit balance", "balance due"],
  paymentType: ["payment type", "payment method", "payment"],
  bankName: ["payment destination", "bank name", "bank", "bank provider", "provider"],
  recipientAccount: ["recipient account no", "recipient account number", "account no", "account number", "recipient account"],
  notes: ["notes", "note"],
  sourceSheet: ["source sheet", "source"],
};

const PAYMENT_TYPES = new Map([
  ["cash", "CASH"],
  ["bank", "BANK_TRANSFER"],
  ["bank transfer", "BANK_TRANSFER"],
  ["transfer", "BANK_TRANSFER"],
  ["mobile money", "MOBILE_MONEY"],
  ["telebirr", "MOBILE_MONEY"],
  ["m pesa", "MOBILE_MONEY"],
  ["mpesa", "MOBILE_MONEY"],
  ["card", "CARD"],
  ["credit", "CREDIT"],
  ["withold", "BANK_TRANSFER"],
  ["withhold", "BANK_TRANSFER"],
  ["payment details unknown", "LEGACY_UNKNOWN"],
  ["legacy unknown", "LEGACY_UNKNOWN"],
  ["unknown", "LEGACY_UNKNOWN"],
]);

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function cellText(cell) {
  const value = cell?.value;
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    if (value.result !== undefined) return String(value.result).trim();
    if (value.formula !== undefined) return "";
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join("").trim();
    if (value.text !== undefined) return String(value.text).trim();
  }
  return String(value).trim();
}

function findHeaderRow(worksheet) {
  const maximum = Math.min(worksheet.rowCount, 30);
  for (let rowNumber = 1; rowNumber <= maximum; rowNumber += 1) {
    const headers = new Set();
    worksheet.getRow(rowNumber).eachCell((cell) => headers.add(normalizeText(cellText(cell))));
    const hasDate = HEADER_ALIASES.date.some((alias) => headers.has(normalizeText(alias)));
    const hasProduct = HEADER_ALIASES.product.some((alias) => headers.has(normalizeText(alias)));
    const hasQuantity = HEADER_ALIASES.quantity.some((alias) => headers.has(normalizeText(alias)));
    const hasAmount = HEADER_ALIASES.amount.some((alias) => headers.has(normalizeText(alias)));
    if (hasDate && hasProduct && hasQuantity && hasAmount) return rowNumber;
  }
  return null;
}

function importColumns(worksheet, headerRow) {
  const headerMap = new Map();
  worksheet.getRow(headerRow).eachCell((cell, column) => headerMap.set(normalizeText(cellText(cell)), column));
  return Object.fromEntries(Object.entries(HEADER_ALIASES).map(([field, aliases]) => [
    field,
    aliases.map((alias) => headerMap.get(normalizeText(alias))).find(Boolean),
  ]));
}

function findNamedHeaderRow(worksheet, requiredHeaders) {
  const required = requiredHeaders.map(normalizeText);
  for (let rowNumber = 1; rowNumber <= Math.min(worksheet.rowCount, 30); rowNumber += 1) {
    const values = new Set();
    worksheet.getRow(rowNumber).eachCell((cell) => values.add(normalizeText(cellText(cell))));
    if (required.every((header) => values.has(header))) return rowNumber;
  }
  return null;
}

function columnsByHeader(worksheet, headerRow) {
  const columns = new Map();
  worksheet.getRow(headerRow).eachCell((cell, column) => columns.set(normalizeText(cellText(cell)), column));
  return columns;
}

function parseDateCell(cell, rowNumber, errors) {
  const raw = cell?.value;
  let date;
  if (raw instanceof Date) date = new Date(raw);
  else if (typeof raw === "number") date = new Date(Math.round((raw - 25569) * 86400 * 1000));
  else {
    const text = cellText(cell);
    date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T12:00:00`) : new Date(text);
  }
  if (!date || Number.isNaN(date.getTime())) {
    errors.push(`Row ${rowNumber}: Date of Sale is invalid`);
    return null;
  }
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (date > tomorrow) {
    errors.push(`Row ${rowNumber}: Date of Sale cannot be in the future`);
    return null;
  }
  return date;
}

function parseMoneyCents(value, rowNumber, errors) {
  const normalized = String(value || "").replace(/etb/gi, "").replace(/,/g, "").replace(/\s/g, "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    errors.push(`Row ${rowNumber}: Amount must be a positive number with at most 2 decimal places`);
    return null;
  }
  const [whole, decimals = ""] = normalized.split(".");
  const cents = BigInt(whole) * 100n + BigInt((decimals + "00").slice(0, 2));
  if (cents <= 0n || cents > 100_000_000_000n) {
    errors.push(`Row ${rowNumber}: Amount must be greater than zero and no more than ETB 1,000,000,000`);
    return null;
  }
  return cents;
}

function parseOptionalMoneyCents(value, rowNumber, label, errors) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const normalized = String(value).replace(/etb/gi, "").replace(/,/g, "").replace(/\s/g, "").trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) {
    errors.push(`Row ${rowNumber}: ${label} must be a valid number`);
    return null;
  }
  const number = Number(normalized);
  if (!Number.isFinite(number) || Math.abs(number) > 1_000_000_000) {
    errors.push(`Row ${rowNumber}: ${label} is outside the supported range`);
    return null;
  }
  return BigInt(Math.round(number * 100));
}

function measurementFromText(value) {
  const match = String(value || "").match(/(\d+)\s*[x×*]\s*(\d+)\s*[x×*]\s*(\d+)/i);
  return match ? { length: Number(match[1]), width: Number(match[2]), thickness: Number(match[3]) } : null;
}

function sameMeasurement(product, measurement) {
  return !measurement || (product.length === measurement.length && product.width === measurement.width && product.thickness === measurement.thickness);
}

function productLabel(product) {
  const measurement = product.length && product.width && product.thickness
    ? `${product.length} × ${product.width} × ${product.thickness}`
    : "No measurement";
  return `${product.sku} · ${product.name} · ${measurement}`;
}

function resolveProduct(rawProduct, rawProductType, products) {
  const productText = String(rawProduct || "").trim();
  const typeText = String(rawProductType || "").trim();
  const normalizedProduct = normalizeText(productText);
  const normalizedType = normalizeText(typeText);
  const measurement = measurementFromText(productText) || measurementFromText(typeText);

  const exactSku = products.find((product) => normalizeText(product.sku) === normalizedProduct);
  if (exactSku) return { product: exactSku };

  const skuPrefix = products.find((product) => normalizedProduct.startsWith(`${normalizeText(product.sku)} `));
  if (skuPrefix) return { product: skuPrefix };

  const withoutMeasurement = normalizeText(productText.replace(/\d+\s*[x×*]\s*\d+\s*[x×*]\s*\d+/i, ""))
    .replace(/\b(slab|material|product|item)\b/g, "").trim();
  const candidateNames = [...new Set([withoutMeasurement, normalizedProduct, normalizedType].filter(Boolean))];
  let matches = products.filter((product) => candidateNames.includes(normalizeText(product.name)) && sameMeasurement(product, measurement));

  if (!matches.length && measurement && normalizedType) {
    matches = products.filter((product) => normalizeText(product.name) === normalizedType && sameMeasurement(product, measurement));
  }
  if (matches.length === 1) return { product: matches[0] };
  if (matches.length > 1) return { error: `matches ${matches.length} catalogue measurements. Enter the exact SKU or use “Product name · L × W × T”` };
  return { error: "does not match an active catalogue item. Enter the exact SKU or use “Product name · L × W × T”" };
}

async function parseSalesWorkbook(buffer, products) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    try {
      const archive = await JSZip.loadAsync(buffer);
      const xmlFiles = Object.values(archive.files).filter((file) => !file.dir && /(?:\.xml|\.rels)$/i.test(file.name));
      await Promise.all(xmlFiles.map(async (file) => {
        const xml = await file.async("string");
        if (!xml.includes("<x:") && !xml.includes("</x:")) return;
        archive.file(file.name, xml.replace(/xmlns:x=/g, "xmlns=").replace(/<x:/g, "<").replace(/<\/x:/g, "</"));
      }));
      const normalized = await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
      await workbook.xlsx.load(normalized);
    } catch {
      return { rows: [], expenses: [], movements: [], errors: ["The file is not a readable .xlsx workbook"] };
    }
  }
  const worksheet = workbook.getWorksheet("Sales Entry") || workbook.worksheets[0];
  if (!worksheet) return { rows: [], errors: ["The workbook does not contain a worksheet"] };
  const headerRow = findHeaderRow(worksheet);
  if (!headerRow) return { rows: [], errors: ["Could not find the sales headers. Keep Date of Sale, Material / Product, Quantity Sold, and Amount (ETB) in one row"] };
  const columns = importColumns(worksheet, headerRow);
  const errors = [];
  for (const [field, label] of [["date", "Date of Sale"], ["product", "Material / Product"], ["quantity", "Quantity Sold"], ["amount", "Amount (ETB)"], ["paymentType", "Payment Type"]]) {
    if (!columns[field]) errors.push(`The header row needs a ${label} column`);
  }
  if (errors.length) return { rows: [], errors };

  const rows = [];
  const lastRow = Math.min(worksheet.rowCount, headerRow + 2000);
  for (let rowNumber = headerRow + 1; rowNumber <= lastRow; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const rawProduct = cellText(row.getCell(columns.product));
    const rawQuantity = cellText(row.getCell(columns.quantity));
    const rawAmount = cellText(row.getCell(columns.amount));
    const rawPayment = cellText(row.getCell(columns.paymentType));
    if (![rawProduct, rawQuantity, rawAmount, rawPayment].some((value) => String(value || "").trim())) continue;

    const rowErrorsBefore = errors.length;
    const saleDate = parseDateCell(row.getCell(columns.date), rowNumber, errors);
    const quantity = Number(rawQuantity);
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 10_000_000) errors.push(`Row ${rowNumber}: Quantity Sold must be a positive whole number`);
    const amountCents = parseMoneyCents(rawAmount, rowNumber, errors);
    const unitPriceCents = columns.unitPrice ? parseOptionalMoneyCents(cellText(row.getCell(columns.unitPrice)), rowNumber, "Selling Price", errors) : null;
    const currentSellingPriceCents = columns.currentSellingPrice ? parseOptionalMoneyCents(cellText(row.getCell(columns.currentSellingPrice)), rowNumber, "Current Selling Price", errors) : null;
    const amountReceivedCents = columns.amountReceived ? parseOptionalMoneyCents(cellText(row.getCell(columns.amountReceived)), rowNumber, "Amount Received", errors) : null;
    const outstandingCreditCents = columns.outstandingCredit ? parseOptionalMoneyCents(cellText(row.getCell(columns.outstandingCredit)), rowNumber, "Outstanding Credit", errors) : null;
    const openingBalance = columns.openingBalance && cellText(row.getCell(columns.openingBalance)) !== "" ? Number(cellText(row.getCell(columns.openingBalance))) : null;
    const remainingInventory = columns.remainingInventory && cellText(row.getCell(columns.remainingInventory)) !== "" ? Number(cellText(row.getCell(columns.remainingInventory))) : null;
    if (openingBalance !== null && (!Number.isInteger(openingBalance) || openingBalance < 0)) errors.push(`Row ${rowNumber}: Beginning Balance must be zero or a positive whole number`);
    if (remainingInventory !== null && (!Number.isInteger(remainingInventory) || remainingInventory < 0)) errors.push(`Row ${rowNumber}: Remaining Inventory must be zero or a positive whole number`);
    const historicalRow = openingBalance !== null || remainingInventory !== null || Boolean(columns.sourceSheet && cellText(row.getCell(columns.sourceSheet)));
    const paymentMethod = PAYMENT_TYPES.get(normalizeText(rawPayment));
    if (!paymentMethod) errors.push(`Row ${rowNumber}: Payment Type must be Bank Transfer, Credit, Cash, Mobile Money, Card, or Legacy / Unknown`);

    let bankName = columns.bankName ? String(cellText(row.getCell(columns.bankName)) || "").trim() : "";
    let recipientAccount = columns.recipientAccount ? String(cellText(row.getCell(columns.recipientAccount)) || "").trim() : "";
    if (paymentMethod === "BANK_TRANSFER" && !bankName) {
      if (historicalRow) bankName = "Bank transfer";
      else errors.push(`Row ${rowNumber}: Bank Transfer requires Bank Name`);
    }
    if (["BANK_TRANSFER", "MOBILE_MONEY"].includes(paymentMethod) && !recipientAccount) {
      if (historicalRow) recipientAccount = "Account not recorded";
      else errors.push(`Row ${rowNumber}: ${rawPayment} requires Recipient Account No.`);
    }
    if (bankName.length > 150) errors.push(`Row ${rowNumber}: Bank Name cannot exceed 150 characters`);
    if (recipientAccount.length > 150) errors.push(`Row ${rowNumber}: Recipient Account No. cannot exceed 150 characters`);

    const rawProductType = columns.productType ? cellText(row.getCell(columns.productType)) : "";
    const explicitMeasurement = [columns.length, columns.width, columns.thickness].every(Boolean)
      ? [columns.length, columns.width, columns.thickness].map((column) => Number(cellText(row.getCell(column))))
      : null;
    const productLookup = explicitMeasurement && explicitMeasurement.every((value) => Number.isInteger(value) && value > 0)
      ? `${rawProduct} · ${explicitMeasurement.join(" × ")}`
      : rawProduct;
    const resolved = resolveProduct(productLookup, rawProductType, products);
    const fallbackMeasurement = explicitMeasurement && explicitMeasurement.every((value) => Number.isInteger(value) && value > 0)
      ? { length: explicitMeasurement[0], width: explicitMeasurement[1], thickness: explicitMeasurement[2] }
      : measurementFromText(productLookup);
    const fallbackName = String(rawProductType || String(rawProduct).replace(/\d+\s*[x×*]\s*\d+\s*[x×*]\s*\d+/i, "").replace(/[·-]+$/g, "")).trim();
    if (!resolved.product && (!fallbackMeasurement || fallbackName.length < 2)) errors.push(`Row ${rowNumber}: “${productLookup}” ${resolved.error}`);
    if (errors.length !== rowErrorsBefore) continue;

    const calculatedCreditCents = amountReceivedCents === null ? (paymentMethod === "CREDIT" ? amountCents : 0n) : amountCents - amountReceivedCents;
    const creditBalanceCents = outstandingCreditCents === null ? calculatedCreditCents : outstandingCreditCents;
    if (creditBalanceCents < 0n || creditBalanceCents > amountCents) {
      errors.push(`Row ${rowNumber}: Outstanding Credit must be between zero and Total Sales`);
      continue;
    }
    const collectedCents = amountCents - creditBalanceCents;

    rows.push({
      rowNumber,
      saleDate,
      product: resolved.product || null,
      productSpec: resolved.product ? null : { name: fallbackName, ...fallbackMeasurement },
      productType: String(rawProductType || "").trim() || null,
      customerName: columns.customer ? String(cellText(row.getCell(columns.customer)) || "").trim().slice(0, 150) || null : null,
      quantity,
      amountCents,
      unitPriceCents,
      currentSellingPriceCents,
      collectedCents,
      creditBalanceCents,
      openingBalance,
      remainingInventory,
      historical: historicalRow,
      paymentMethod,
      bankName: paymentMethod === "CASH" || paymentMethod === "CREDIT" ? null : bankName || null,
      recipientAccount: paymentMethod === "CASH" || paymentMethod === "CREDIT" ? null : recipientAccount || null,
      notes: columns.notes ? String(cellText(row.getCell(columns.notes)) || "").trim().slice(0, 1000) || null : null,
      sourceSheet: columns.sourceSheet ? String(cellText(row.getCell(columns.sourceSheet)) || "").trim().slice(0, 100) || null : null,
    });
  }
  if (worksheet.rowCount > headerRow + 2000) errors.push("The workbook exceeds the 2,000 sales row limit");
  if (!rows.length && !errors.length) errors.push("The workbook does not contain any sales rows");

  const expenses = [];
  const expenseSheet = workbook.getWorksheet("Owner Expense Account") || workbook.getWorksheet("Expense Account");
  if (expenseSheet) {
    const expenseHeader = findNamedHeaderRow(expenseSheet, ["Date", "Entry Type", "Amount"]);
    if (!expenseHeader) errors.push("Owner Expense Account needs Date, Entry Type, and Amount headers");
    else {
      const columns = columnsByHeader(expenseSheet, expenseHeader);
      let inheritedDate = null;
      for (let rowNumber = expenseHeader + 1; rowNumber <= Math.min(expenseSheet.rowCount, expenseHeader + 2000); rowNumber += 1) {
        const row = expenseSheet.getRow(rowNumber);
        const rawType = cellText(row.getCell(columns.get("entry type")));
        const rawAmount = cellText(row.getCell(columns.get("amount")));
        const rawDate = cellText(row.getCell(columns.get("date")));
        if (![rawType, rawAmount, rawDate].some((value) => String(value || "").trim())) continue;
        if (rawDate) inheritedDate = parseDateCell(row.getCell(columns.get("date")), rowNumber, errors);
        if (!inheritedDate) { errors.push(`Owner Expense Account row ${rowNumber}: Date is required`); continue; }
        const normalizedType = normalizeText(rawType);
        const entryType = ["in", "funds added", "add funds"].includes(normalizedType) ? "IN" : ["out", "spending", "spent"].includes(normalizedType) ? "OUT" : null;
        if (!entryType) { errors.push(`Owner Expense Account row ${rowNumber}: Entry Type must be In or Out`); continue; }
        const amountCents = parseOptionalMoneyCents(rawAmount, rowNumber, "Expense amount", errors);
        if (amountCents === null || amountCents <= 0n) { errors.push(`Owner Expense Account row ${rowNumber}: Amount must be greater than zero`); continue; }
        expenses.push({ rowNumber, entryType, amountCents, transactionDate: new Date(inheritedDate), note: columns.get("note") ? String(cellText(row.getCell(columns.get("note"))) || "").trim().slice(0, 1000) || null : null });
      }
    }
  }

  const movements = [];
  const movementSheet = workbook.getWorksheet("Inventory History") || workbook.getWorksheet("Inventory Movements");
  if (movementSheet) {
    const movementHeader = findNamedHeaderRow(movementSheet, ["Date", "Material / Product", "Movement Type", "Quantity"]);
    if (!movementHeader) errors.push("Inventory History needs Date, Material / Product, Movement Type, and Quantity headers");
    else {
      const columns = columnsByHeader(movementSheet, movementHeader);
      let inheritedDate = null;
      for (let rowNumber = movementHeader + 1; rowNumber <= Math.min(movementSheet.rowCount, movementHeader + 5000); rowNumber += 1) {
        const row = movementSheet.getRow(rowNumber);
        const rawProduct = cellText(row.getCell(columns.get("material product")));
        const rawType = cellText(row.getCell(columns.get("movement type")));
        const rawQuantity = cellText(row.getCell(columns.get("quantity")));
        const rawDate = cellText(row.getCell(columns.get("date")));
        if (![rawProduct, rawType, rawQuantity, rawDate].some((value) => String(value || "").trim())) continue;
        if (rawDate) inheritedDate = parseDateCell(row.getCell(columns.get("date")), rowNumber, errors);
        if (!inheritedDate) { errors.push(`Inventory History row ${rowNumber}: Date is required`); continue; }
        const quantity = Number(rawQuantity);
        if (!Number.isInteger(quantity) || quantity <= 0) { errors.push(`Inventory History row ${rowNumber}: Quantity must be a positive whole number`); continue; }
        const type = normalizeText(rawType);
        const movementType = type === "in" || type === "stock in" ? "STOCK_IN" : type === "out" || type === "stock out" ? "ADJUSTMENT_OUT" : null;
        if (!movementType) { errors.push(`Inventory History row ${rowNumber}: Movement Type must be In or Out`); continue; }
        const rawProductType = columns.get("product type") ? cellText(row.getCell(columns.get("product type"))) : "";
        const resolved = resolveProduct(rawProduct, rawProductType, products);
        const fallbackMeasurement = measurementFromText(rawProduct);
        const fallbackName = String(rawProductType || String(rawProduct).replace(/\d+\s*[x×*]\s*\d+\s*[x×*]\s*\d+/i, "").replace(/[·-]+$/g, "")).trim();
        if (!resolved.product && (!fallbackMeasurement || fallbackName.length < 2)) { errors.push(`Inventory History row ${rowNumber}: “${rawProduct}” ${resolved.error}`); continue; }
        const rawBalance = columns.get("balance after") ? cellText(row.getCell(columns.get("balance after"))) : "";
        const balanceAfter = rawBalance === "" ? null : Number(rawBalance);
        if (balanceAfter !== null && (!Number.isInteger(balanceAfter) || balanceAfter < 0)) { errors.push(`Inventory History row ${rowNumber}: Balance After must be zero or a positive whole number`); continue; }
        movements.push({ rowNumber, product: resolved.product || null, productSpec: resolved.product ? null : { name: fallbackName, ...fallbackMeasurement }, movementType, quantity, balanceAfter, transactionDate: new Date(inheritedDate), notes: columns.get("note") ? String(cellText(row.getCell(columns.get("note"))) || "").trim().slice(0, 1000) || null : null });
      }
    }
  }

  return { rows, expenses, movements, errors, headerRow };
}

module.exports = {
  parseSalesWorkbook,
  productLabel,
  resolveProduct,
  normalizeText,
};
