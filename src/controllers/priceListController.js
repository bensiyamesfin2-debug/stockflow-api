const prisma = require("../config/prisma");
const HttpError = require("../utils/HttpError");
const { moneyToCents, centsToMoney } = require("../utils/money");
const { runSerializableTransaction } = require("../utils/transaction");

function cleanText(value, limit) {
  const normalized = String(value || "").trim().replace(/\s+/g, " ");
  return normalized && normalized.length <= limit ? normalized : null;
}

function optionalText(value, limit) {
  if (value === undefined || value === null || value === "") return null;
  return cleanText(value, limit);
}

function normalizeItems(rawItems, errors) {
  if (rawItems === undefined) return undefined;
  if (!Array.isArray(rawItems) || rawItems.length > 600) {
    errors.push("Price-list items must be a list of no more than 600 products");
    return [];
  }
  const productIds = new Set();
  return rawItems.map((rawItem, index) => {
    const productId = Number(rawItem?.productId);
    const priceCents = moneyToCents(rawItem?.price);
    if (!Number.isInteger(productId) || productId <= 0) errors.push(`Price item ${index + 1} has an invalid product`);
    if (priceCents === null || priceCents < 0n) errors.push(`Price item ${index + 1} needs a valid non-negative price`);
    if (productIds.has(productId)) errors.push(`Product ${productId} appears more than once`);
    productIds.add(productId);
    return { productId, priceCents };
  });
}

function normalizePriceList(body, partial = false) {
  const errors = [];
  const data = {};
  if (!partial || body.name !== undefined) {
    const name = cleanText(body.name, 120);
    if (!name) errors.push("Price-list name is required and must be 120 characters or shorter");
    else data.name = name;
  }
  if (body.description !== undefined) {
    const description = optionalText(body.description, 2000);
    if (body.description && !description) errors.push("Description cannot exceed 2,000 characters");
    else data.description = description;
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") errors.push("isActive must be true or false");
    else data.isActive = body.isActive;
  }
  if (body.isDefault !== undefined) {
    if (typeof body.isDefault !== "boolean") errors.push("isDefault must be true or false");
    else data.isDefault = body.isDefault;
  }
  const items = normalizeItems(body.items, errors);
  return { data, items, errors };
}

const priceListInclude = {
  createdBy: { select: { id: true, fullName: true } },
  items: {
    include: {
      product: { select: { id: true, sku: true, name: true, length: true, width: true, thickness: true, sellingPrice: true } },
    },
    orderBy: { product: { name: "asc" } },
  },
  _count: { select: { customers: true, sales: true } },
};

async function listPriceLists(req, res) {
  const priceLists = await prisma.priceList.findMany({
    where: req.user.role === "ADMIN" && req.query.active === "all" ? undefined : { isActive: true },
    include: priceListInclude,
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    take: 100,
  });
  return res.json({ success: true, data: { priceLists } });
}

async function createPriceList(req, res) {
  const { data, items, errors } = normalizePriceList(req.body);
  if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });
  const priceItems = items || [];
  const productIds = priceItems.map((item) => item.productId);
  const products = productIds.length
    ? await prisma.product.count({ where: { id: { in: productIds } } })
    : 0;
  if (products !== productIds.length) return res.status(400).json({ success: false, message: "One or more price-list products do not exist" });

  try {
    const priceList = await runSerializableTransaction(async (transaction) => {
      if (data.isDefault) await transaction.priceList.updateMany({ data: { isDefault: false } });
      const created = await transaction.priceList.create({
        data: {
          ...data,
          createdById: req.user.id,
          items: { create: priceItems.map((item) => ({ productId: item.productId, price: centsToMoney(item.priceCents) })) },
        },
        include: priceListInclude,
      });
      await transaction.auditLog.create({ data: { userId: req.user.id, action: "CREATE_PRICE_LIST", entityType: "PRICE_LIST", entityId: created.id, details: { name: created.name, products: priceItems.length, isDefault: created.isDefault } } });
      return created;
    });
    return res.status(201).json({ success: true, message: "Customer price list created", data: { priceList } });
  } catch (error) {
    if (error.code === "P2002") return res.status(409).json({ success: false, message: "That price-list name already exists" });
    throw error;
  }
}

async function updatePriceList(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Invalid price-list ID");
  const { data, items, errors } = normalizePriceList(req.body, true);
  if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });
  if (!Object.keys(data).length && items === undefined) throw new HttpError(400, "Provide a price-list change");
  if (items !== undefined) {
    const products = items.length ? await prisma.product.count({ where: { id: { in: items.map((item) => item.productId) } } }) : 0;
    if (products !== items.length) return res.status(400).json({ success: false, message: "One or more price-list products do not exist" });
  }
  try {
    const priceList = await runSerializableTransaction(async (transaction) => {
      const existing = await transaction.priceList.findUnique({ where: { id } });
      if (!existing) return null;
      if (data.isDefault) await transaction.priceList.updateMany({ where: { id: { not: id } }, data: { isDefault: false } });
      if (items !== undefined) await transaction.priceListItem.deleteMany({ where: { priceListId: id } });
      const updated = await transaction.priceList.update({
        where: { id },
        data: {
          ...data,
          ...(items !== undefined ? { items: { create: items.map((item) => ({ productId: item.productId, price: centsToMoney(item.priceCents) })) } } : {}),
        },
        include: priceListInclude,
      });
      await transaction.auditLog.create({ data: { userId: req.user.id, action: "UPDATE_PRICE_LIST", entityType: "PRICE_LIST", entityId: id, details: { fields: Object.keys(data), replacedItems: items !== undefined } } });
      return updated;
    });
    if (!priceList) return res.status(404).json({ success: false, message: "Price list not found" });
    return res.json({ success: true, message: "Price list updated", data: { priceList } });
  } catch (error) {
    if (error.code === "P2002") return res.status(409).json({ success: false, message: "That price-list name already exists" });
    throw error;
  }
}

module.exports = { listPriceLists, createPriceList, updatePriceList, normalizePriceList };
