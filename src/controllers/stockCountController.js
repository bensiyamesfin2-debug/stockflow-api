const { randomUUID } = require("crypto");
const prisma = require("../config/prisma");
const HttpError = require("../utils/HttpError");
const { normalizeOptionalText } = require("../utils/validation");
const { runSerializableTransaction } = require("../utils/transaction");

function makeCountNumber() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `COUNT-${date}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

const stockCountInclude = {
  createdBy: { select: { id: true, fullName: true, username: true } },
  completedBy: { select: { id: true, fullName: true, username: true } },
  adjustedBy: { select: { id: true, fullName: true, username: true } },
  items: {
    include: {
      product: {
        select: { id: true, sku: true, name: true, length: true, width: true, thickness: true },
      },
    },
    orderBy: { id: "asc" },
  },
};

function serializeStockCount(count) {
  const variances = count.items.filter(
    (item) => item.countedQuantity !== null && item.countedQuantity !== item.expectedQuantity
  );
  return {
    ...count,
    summary: {
      products: count.items.length,
      counted: count.items.filter((item) => item.countedQuantity !== null).length,
      variances: variances.length,
      netVariance: variances.reduce(
        (sum, item) => sum + item.countedQuantity - item.expectedQuantity,
        0
      ),
    },
  };
}

async function listStockCounts(req, res) {
  const status = req.query.status ? String(req.query.status).toUpperCase() : undefined;
  if (status && !new Set(["DRAFT", "COMPLETED", "ADJUSTED"]).has(status)) {
    return res.status(400).json({ success: false, message: "Invalid stock-count status" });
  }
  const counts = await prisma.stockCount.findMany({
    where: status ? { status } : undefined,
    include: stockCountInclude,
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return res.json({ success: true, data: { stockCounts: counts.map(serializeStockCount) } });
}

async function createStockCount(req, res) {
  const notes = normalizeOptionalText(req.body.notes, 2000);
  if (req.body.notes && !notes) return res.status(400).json({ success: false, message: "Notes cannot exceed 2,000 characters" });

  let productIds;
  if (req.body.productIds !== undefined) {
    if (!Array.isArray(req.body.productIds) || req.body.productIds.length === 0 || req.body.productIds.length > 500) {
      return res.status(400).json({ success: false, message: "productIds must contain between 1 and 500 products" });
    }
    productIds = [...new Set(req.body.productIds.map(Number))];
    if (productIds.some((id) => !Number.isInteger(id) || id <= 0)) {
      return res.status(400).json({ success: false, message: "One or more product IDs are invalid" });
    }
  }

  const count = await runSerializableTransaction(async (transaction) => {
    const inventory = await transaction.inventory.findMany({
      where: {
        product: {
          isActive: true,
          ...(productIds ? { id: { in: productIds } } : {}),
        },
      },
      include: { product: { select: { id: true } } },
      orderBy: { productId: "asc" },
    });
    if (productIds && inventory.length !== productIds.length) {
      throw new HttpError(400, "One or more products do not exist or are inactive");
    }
    if (!inventory.length) throw new HttpError(409, "There are no active products to count");

    const created = await transaction.stockCount.create({
      data: {
        countNumber: makeCountNumber(),
        createdById: req.user.id,
        notes,
        items: {
          create: inventory.map((record) => ({
            productId: record.productId,
            expectedQuantity: record.quantity,
          })),
        },
      },
      include: stockCountInclude,
    });
    await transaction.auditLog.create({
      data: {
        userId: req.user.id,
        action: "CREATE_STOCK_COUNT",
        entityType: "STOCK_COUNT",
        entityId: created.id,
        details: { countNumber: created.countNumber, productCount: inventory.length },
      },
    });
    return created;
  });

  return res.status(201).json({ success: true, message: "Stock count started", data: { stockCount: serializeStockCount(count) } });
}

function normalizeCountedItems(rawItems) {
  const errors = [];
  if (!Array.isArray(rawItems) || rawItems.length === 0) return { items: [], errors: ["At least one counted item is required"] };
  if (rawItems.length > 500) errors.push("A stock count cannot contain more than 500 submitted items");
  const ids = new Set();
  const items = rawItems.map((rawItem, index) => {
    const productId = Number(rawItem?.productId);
    const countedQuantity = Number(rawItem?.countedQuantity);
    if (!Number.isInteger(productId) || productId <= 0) errors.push(`Item ${index + 1} has an invalid product ID`);
    if (!Number.isInteger(countedQuantity) || countedQuantity < 0) errors.push(`Item ${index + 1} count must be a non-negative whole number`);
    if (Number.isInteger(productId) && ids.has(productId)) errors.push(`Product ${productId} appears more than once`);
    ids.add(productId);
    return { productId, countedQuantity };
  });
  return { items, errors };
}

async function completeStockCount(req, res) {
  const countId = Number(req.params.id);
  if (!Number.isInteger(countId) || countId <= 0) return res.status(400).json({ success: false, message: "Invalid stock-count ID" });
  const { items, errors } = normalizeCountedItems(req.body.items);
  if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });

  const count = await runSerializableTransaction(async (transaction) => {
    const existing = await transaction.stockCount.findUnique({ where: { id: countId }, include: { items: true } });
    if (!existing) throw new HttpError(404, "Stock count not found");
    if (existing.status !== "DRAFT") throw new HttpError(409, "Only a draft stock count can be completed");
    const expectedProducts = new Set(existing.items.map((item) => item.productId));
    if (items.length !== expectedProducts.size || items.some((item) => !expectedProducts.has(item.productId))) {
      throw new HttpError(400, "A counted quantity is required for every product in this stock count");
    }
    const submitted = new Map(items.map((item) => [item.productId, item.countedQuantity]));
    for (const item of existing.items) {
      const countedQuantity = submitted.get(item.productId);
      await transaction.stockCountItem.update({
        where: { id: item.id },
        data: {
          countedQuantity,
          adjustmentQuantity: countedQuantity - item.expectedQuantity,
        },
      });
    }
    await transaction.stockCount.update({
      where: { id: countId },
      data: { status: "COMPLETED", completedAt: new Date(), completedById: req.user.id },
    });
    await transaction.auditLog.create({
      data: {
        userId: req.user.id,
        action: "COMPLETE_STOCK_COUNT",
        entityType: "STOCK_COUNT",
        entityId: countId,
        details: { varianceProducts: existing.items.filter((item) => submitted.get(item.productId) !== item.expectedQuantity).length },
      },
    });
    return transaction.stockCount.findUnique({ where: { id: countId }, include: stockCountInclude });
  });

  return res.json({ success: true, message: "Stock count completed and ready for review", data: { stockCount: serializeStockCount(count) } });
}

async function adjustStockCount(req, res) {
  const countId = Number(req.params.id);
  if (!Number.isInteger(countId) || countId <= 0) return res.status(400).json({ success: false, message: "Invalid stock-count ID" });
  const reason = normalizeOptionalText(req.body.reason, 1000);
  if (!reason) return res.status(400).json({ success: false, message: "An adjustment reason is required and cannot exceed 1,000 characters" });

  const count = await runSerializableTransaction(async (transaction) => {
    const existing = await transaction.stockCount.findUnique({
      where: { id: countId },
      include: { items: true },
    });
    if (!existing) throw new HttpError(404, "Stock count not found");
    if (existing.status !== "COMPLETED") throw new HttpError(409, "Only a completed stock count can adjust inventory");

    for (const item of existing.items) {
      if (item.countedQuantity === null || item.adjustmentQuantity === null) {
        throw new HttpError(409, "The stock count is missing counted quantities");
      }
      const inventory = await transaction.inventory.findUnique({ where: { productId: item.productId } });
      if (!inventory) throw new HttpError(409, `Inventory is missing for product ${item.productId}`);
      if (inventory.quantity !== item.expectedQuantity) {
        throw new HttpError(
          409,
          `Inventory changed after this count began for product ${item.productId}; start a new count`
        );
      }
      if (item.countedQuantity < inventory.reservedQuantity) {
        throw new HttpError(
          409,
          `Product ${item.productId} cannot be reduced below its ${inventory.reservedQuantity} reserved unit(s)`
        );
      }
    }

    for (const item of existing.items) {
      const inventory = await transaction.inventory.update({
        where: { productId: item.productId },
        data: { quantity: item.countedQuantity },
      });
      if (item.adjustmentQuantity !== 0) {
        await transaction.inventoryMovement.create({
          data: {
            productId: item.productId,
            movementType: item.adjustmentQuantity > 0 ? "ADJUSTMENT_IN" : "ADJUSTMENT_OUT",
            quantityChange: item.adjustmentQuantity,
            balanceAfter: inventory.quantity,
            referenceType: "STOCK_COUNT",
            referenceId: countId,
            createdById: req.user.id,
            notes: reason,
          },
        });
      }
    }
    await transaction.stockCount.update({
      where: { id: countId },
      data: {
        status: "ADJUSTED",
        adjustedAt: new Date(),
        adjustedById: req.user.id,
        notes: [existing.notes, `Adjustment: ${reason}`].filter(Boolean).join("\n"),
      },
    });
    await transaction.auditLog.create({
      data: {
        userId: req.user.id,
        action: "ADJUST_STOCK_COUNT",
        entityType: "STOCK_COUNT",
        entityId: countId,
        details: { reason, adjustedProducts: existing.items.filter((item) => item.adjustmentQuantity !== 0).length },
      },
    });
    return transaction.stockCount.findUnique({ where: { id: countId }, include: stockCountInclude });
  });

  return res.json({ success: true, message: "Inventory adjusted from stock count", data: { stockCount: serializeStockCount(count) } });
}

module.exports = {
  listStockCounts,
  createStockCount,
  completeStockCount,
  adjustStockCount,
  normalizeCountedItems,
};
