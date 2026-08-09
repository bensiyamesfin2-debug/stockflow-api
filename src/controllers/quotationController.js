const { randomUUID } = require("crypto");
const prisma = require("../config/prisma");
const HttpError = require("../utils/HttpError");
const { moneyToCents, centsToMoney } = require("../utils/money");
const { runSerializableTransaction } = require("../utils/transaction");
const { resolveCustomerPriceList, saleUnitPriceCents } = require("../utils/priceLists");
const { deliverWhatsAppText, quotationWhatsAppMessage } = require("../utils/whatsapp");

const QUOTATION_STATUSES = new Set(["DRAFT", "SENT", "ACCEPTED", "DECLINED", "EXPIRED", "CANCELLED"]);

function cleanText(value, limit) {
  const normalized = String(value || "").trim().replace(/\s+/g, " ");
  return normalized && normalized.length <= limit ? normalized : null;
}

function optionalText(value, limit) {
  if (value === undefined || value === null || value === "") return null;
  return cleanText(value, limit);
}

function makeQuoteNumber() {
  return `QTE-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

function squareCmToSqm(squareCm) {
  const scaled = (squareCm * 1000n + 5000n) / 10000n;
  return `${scaled / 1000n}.${String(scaled % 1000n).padStart(3, "0")}`;
}

function quoteLineTotalCents(unitPriceCents, squareCm) {
  return (unitPriceCents * squareCm + 5000n) / 10000n;
}

function normalizeQuotation(body) {
  const errors = [];
  const customerId = body.customerId === undefined || body.customerId === null || body.customerId === "" ? null : Number(body.customerId);
  const customerName = optionalText(body.customerName, 150);
  const customerPhone = optionalText(body.customerPhone, 40);
  const validUntil = body.validUntil ? new Date(body.validUntil) : null;
  const notes = optionalText(body.notes, 2000);
  if (customerId !== null && (!Number.isInteger(customerId) || customerId <= 0)) errors.push("Customer is invalid");
  if (body.customerName && !customerName) errors.push("Customer name cannot exceed 150 characters");
  if (body.customerPhone && !customerPhone) errors.push("Customer phone cannot exceed 40 characters");
  if (body.validUntil && (!validUntil || Number.isNaN(validUntil.getTime()))) errors.push("Quote valid-until date is invalid");
  if (body.notes && !notes) errors.push("Notes cannot exceed 2,000 characters");
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 100) {
    errors.push("A quotation needs between 1 and 100 measurement lines");
  }
  const items = Array.isArray(body.items) ? body.items.map((rawItem, index) => {
    const productId = Number(rawItem?.productId);
    const lengthCm = Number(rawItem?.lengthCm);
    const widthCm = Number(rawItem?.widthCm);
    const thicknessCm = rawItem?.thicknessCm === undefined || rawItem?.thicknessCm === null || rawItem?.thicknessCm === "" ? null : Number(rawItem.thicknessCm);
    const quantity = Number(rawItem?.quantity);
    const unitPricePerSqmCents = rawItem?.unitPricePerSqm === undefined || rawItem?.unitPricePerSqm === null || rawItem?.unitPricePerSqm === "" ? null : moneyToCents(rawItem.unitPricePerSqm);
    const description = optionalText(rawItem?.description, 240);
    if (!Number.isInteger(productId) || productId <= 0) errors.push(`Quote line ${index + 1} needs a product`);
    if (!Number.isInteger(lengthCm) || lengthCm <= 0 || lengthCm > 100000) errors.push(`Quote line ${index + 1} length must be a positive whole number in cm`);
    if (!Number.isInteger(widthCm) || widthCm <= 0 || widthCm > 100000) errors.push(`Quote line ${index + 1} width must be a positive whole number in cm`);
    if (thicknessCm !== null && (!Number.isInteger(thicknessCm) || thicknessCm <= 0 || thicknessCm > 1000)) errors.push(`Quote line ${index + 1} thickness must be a positive whole number in cm`);
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 100000) errors.push(`Quote line ${index + 1} quantity must be a positive whole number`);
    if (unitPricePerSqmCents !== null && unitPricePerSqmCents < 0n) errors.push(`Quote line ${index + 1} has an invalid price per m²`);
    if (rawItem?.description && !description) errors.push(`Quote line ${index + 1} description is too long`);
    return { productId, lengthCm, widthCm, thicknessCm, quantity, unitPricePerSqmCents, description };
  }) : [];
  return { data: { customerId, customerName, customerPhone, validUntil, notes, items }, errors };
}

const quoteInclude = {
  customer: { select: { id: true, name: true, phone: true } },
  createdBy: { select: { id: true, fullName: true, username: true } },
  items: { include: { product: { select: { id: true, sku: true, name: true, length: true, width: true, thickness: true } } } },
};

async function listQuotations(req, res) {
  const quotations = await prisma.quotation.findMany({
    where: req.user.role === "CASHIER" ? { createdById: req.user.id } : undefined,
    include: quoteInclude,
    take: 100,
    orderBy: { createdAt: "desc" },
  });
  return res.json({ success: true, data: { quotations } });
}

async function createQuotation(req, res) {
  const { data, errors } = normalizeQuotation(req.body);
  if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });
  const quote = await runSerializableTransaction(async (transaction) => {
    const productIds = [...new Set(data.items.map((item) => item.productId))];
    const [products, customer] = await Promise.all([
      transaction.product.findMany({ where: { id: { in: productIds }, isActive: true } }),
      data.customerId ? transaction.customer.findUnique({ where: { id: data.customerId } }) : Promise.resolve(null),
    ]);
    if (products.length !== productIds.length) throw new HttpError(400, "One or more quotation products do not exist or are inactive");
    if (data.customerId && (!customer || !customer.isActive)) throw new HttpError(400, "Customer does not exist or is inactive");
    const productsById = new Map(products.map((product) => [product.id, product]));
    const { priceList, pricesByProduct } = await resolveCustomerPriceList(transaction, customer);
    let totalAreaSqCm = 0n;
    let totalCents = 0n;
    const calculatedItems = data.items.map((item) => {
      const product = productsById.get(item.productId);
      const squareCm = BigInt(item.lengthCm) * BigInt(item.widthCm) * BigInt(item.quantity);
      let unitPricePerSqmCents = item.unitPricePerSqmCents;
      if (unitPricePerSqmCents === null) {
        const referenceSquareCm = product.length && product.width ? BigInt(product.length) * BigInt(product.width) : 0n;
        if (referenceSquareCm <= 0n) throw new HttpError(400, `Enter a price per m² for ${product.name}`);
        unitPricePerSqmCents = (saleUnitPriceCents(product, pricesByProduct) * 10000n + referenceSquareCm / 2n) / referenceSquareCm;
      }
      const lineTotalCents = quoteLineTotalCents(unitPricePerSqmCents, squareCm);
      totalAreaSqCm += squareCm;
      totalCents += lineTotalCents;
      return { ...item, areaSqm: squareCmToSqm(squareCm), unitPricePerSqm: centsToMoney(unitPricePerSqmCents), lineTotal: centsToMoney(lineTotalCents) };
    });
    const created = await transaction.quotation.create({
      data: {
        quoteNumber: makeQuoteNumber(),
        customerId: customer?.id || null,
        customerName: customer?.name || data.customerName,
        customerPhone: customer?.phone || data.customerPhone,
        createdById: req.user.id,
        validUntil: data.validUntil,
        notes: data.notes,
        totalAreaSqm: squareCmToSqm(totalAreaSqCm),
        totalAmount: centsToMoney(totalCents),
        items: { create: calculatedItems.map((item) => ({ productId: item.productId, description: item.description, lengthCm: item.lengthCm, widthCm: item.widthCm, thicknessCm: item.thicknessCm, quantity: item.quantity, areaSqm: item.areaSqm, unitPricePerSqm: item.unitPricePerSqm, lineTotal: item.lineTotal })) },
      },
      include: quoteInclude,
    });
    await transaction.auditLog.create({ data: { userId: req.user.id, action: "CREATE_QUOTATION", entityType: "QUOTATION", entityId: created.id, details: { quoteNumber: created.quoteNumber, totalAreaSqm: created.totalAreaSqm, totalAmount: created.totalAmount, priceListId: priceList?.id || null } } });
    return created;
  });
  void deliverWhatsAppText({ phone: quote.customerPhone, message: quotationWhatsAppMessage(quote) });
  return res.status(201).json({ success: true, message: "Measurement quotation created", data: { quotation: quote } });
}

async function updateQuotation(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Invalid quotation ID");
  const status = req.body.status === undefined ? undefined : String(req.body.status).toUpperCase();
  const validUntil = req.body.validUntil === undefined ? undefined : (req.body.validUntil ? new Date(req.body.validUntil) : null);
  const notes = req.body.notes === undefined ? undefined : optionalText(req.body.notes, 2000);
  if (status !== undefined && !QUOTATION_STATUSES.has(status)) throw new HttpError(400, "Invalid quotation status");
  if (validUntil && Number.isNaN(validUntil.getTime())) throw new HttpError(400, "Quote valid-until date is invalid");
  if (req.body.notes && !notes) throw new HttpError(400, "Notes cannot exceed 2,000 characters");
  if (status === undefined && validUntil === undefined && notes === undefined) throw new HttpError(400, "Provide a quotation change");
  const quotation = await runSerializableTransaction(async (transaction) => {
    const existing = await transaction.quotation.findUnique({ where: { id } });
    if (!existing) return null;
    if (req.user.role === "CASHIER" && existing.createdById !== req.user.id) throw new HttpError(403, "You can only update your own quotation");
    const updated = await transaction.quotation.update({ where: { id }, data: { ...(status ? { status } : {}), ...(validUntil !== undefined ? { validUntil } : {}), ...(notes !== undefined ? { notes } : {}) }, include: quoteInclude });
    await transaction.auditLog.create({ data: { userId: req.user.id, action: "UPDATE_QUOTATION", entityType: "QUOTATION", entityId: id, details: { status, validUntil: validUntil || null } } });
    return updated;
  });
  if (!quotation) return res.status(404).json({ success: false, message: "Quotation not found" });
  return res.json({ success: true, message: "Quotation updated", data: { quotation } });
}

async function sendQuotationWhatsApp(req, res) {
  const id = Number(req.params.id);
  const quotation = await prisma.quotation.findUnique({ where: { id }, include: quoteInclude });
  if (!quotation) throw new HttpError(404, "Quotation not found");
  if (req.user.role === "CASHIER" && quotation.createdById !== req.user.id) throw new HttpError(403, "You can only message your own quotation");
  const delivery = await deliverWhatsAppText({ phone: quotation.customerPhone, message: quotationWhatsAppMessage(quotation) });
  await prisma.auditLog.create({ data: { userId: req.user.id, action: "SEND_QUOTATION_WHATSAPP", entityType: "QUOTATION", entityId: id, details: { delivered: delivery.delivered, available: delivery.available } } });
  return res.json({ success: true, message: delivery.delivered ? "Quotation sent automatically on WhatsApp" : "WhatsApp message is ready to send", data: delivery });
}

module.exports = { listQuotations, createQuotation, updateQuotation, sendQuotationWhatsApp, normalizeQuotation, squareCmToSqm };
