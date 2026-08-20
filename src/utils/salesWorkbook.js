const ExcelJS = require("exceljs");

const HEADER_ALIASES = {
  date: ["date of sale", "sale date", "date"],
  productType: ["product type", "type", "category"],
  product: ["material product", "material / product", "product", "material", "product sku", "sku"],
  quantity: ["quantity sold", "quantity of material sold", "quantity", "qty sold", "qty"],
  amount: ["amount etb", "amount", "sale amount", "total amount", "total"],
  paymentType: ["payment type", "payment method", "payment"],
  bankName: ["bank name", "bank", "bank provider", "provider"],
  recipientAccount: ["recipient account no", "recipient account number", "account no", "account number", "recipient account"],
  notes: ["notes", "note"],
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
    return { rows: [], errors: ["The file is not a readable .xlsx workbook"] };
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
    const paymentMethod = PAYMENT_TYPES.get(normalizeText(rawPayment));
    if (!paymentMethod) errors.push(`Row ${rowNumber}: Payment Type must be Bank Transfer, Credit, Cash, Mobile Money, Card, or Legacy / Unknown`);

    const bankName = columns.bankName ? String(cellText(row.getCell(columns.bankName)) || "").trim() : "";
    const recipientAccount = columns.recipientAccount ? String(cellText(row.getCell(columns.recipientAccount)) || "").trim() : "";
    if (paymentMethod === "BANK_TRANSFER" && !bankName) errors.push(`Row ${rowNumber}: Bank Transfer requires Bank Name`);
    if (["BANK_TRANSFER", "MOBILE_MONEY"].includes(paymentMethod) && !recipientAccount) errors.push(`Row ${rowNumber}: ${rawPayment} requires Recipient Account No.`);
    if (bankName.length > 150) errors.push(`Row ${rowNumber}: Bank Name cannot exceed 150 characters`);
    if (recipientAccount.length > 150) errors.push(`Row ${rowNumber}: Recipient Account No. cannot exceed 150 characters`);

    const rawProductType = columns.productType ? cellText(row.getCell(columns.productType)) : "";
    const resolved = resolveProduct(rawProduct, rawProductType, products);
    if (!resolved.product) errors.push(`Row ${rowNumber}: “${rawProduct}” ${resolved.error}`);
    if (errors.length !== rowErrorsBefore) continue;

    rows.push({
      rowNumber,
      saleDate,
      product: resolved.product,
      productType: String(rawProductType || "").trim() || null,
      quantity,
      amountCents,
      paymentMethod,
      bankName: paymentMethod === "CASH" || paymentMethod === "CREDIT" ? null : bankName || null,
      recipientAccount: paymentMethod === "CASH" || paymentMethod === "CREDIT" ? null : recipientAccount || null,
      notes: columns.notes ? String(cellText(row.getCell(columns.notes)) || "").trim().slice(0, 1000) || null : null,
    });
  }
  if (worksheet.rowCount > headerRow + 2000) errors.push("The workbook exceeds the 2,000 sales row limit");
  if (!rows.length && !errors.length) errors.push("The workbook does not contain any sales rows");
  return { rows, errors, headerRow };
}

module.exports = {
  parseSalesWorkbook,
  productLabel,
  resolveProduct,
  normalizeText,
};
