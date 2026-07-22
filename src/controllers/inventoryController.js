const { randomUUID } = require("crypto");
const prisma = require("../config/prisma");
const { normalizeMoney } = require("../utils/validation");
const { runSerializableTransaction } = require("../utils/transaction");

function makeReceiptNumber() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `GRN-${date}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

function validateReceipt(body) {
  const supplierName = String(body.supplierName || "").trim() || null;
  const referenceNumber = String(body.referenceNumber || "").trim() || null;
  const notes = String(body.notes || "").trim() || null;
  const rawItems = body.items;
  const errors = [];

  if (supplierName && supplierName.length > 150) {
    errors.push("Supplier name cannot exceed 150 characters");
  }

  if (referenceNumber && referenceNumber.length > 150) {
    errors.push("Reference number cannot exceed 150 characters");
  }

  if (notes && notes.length > 2000) {
    errors.push("Notes cannot exceed 2,000 characters");
  }

  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    errors.push("At least one stock item is required");
  } else if (rawItems.length > 100) {
    errors.push("A stock receipt cannot contain more than 100 items");
  }

  const items = [];
  const productIds = new Set();

  if (Array.isArray(rawItems)) {
    rawItems.forEach((rawItem, index) => {
      const productId = Number(rawItem?.productId);
      const quantity = Number(rawItem?.quantity);
      let unitCost = null;

      if (!Number.isInteger(productId) || productId <= 0) {
        errors.push(`Item ${index + 1} has an invalid product ID`);
      }

      if (!Number.isInteger(quantity) || quantity <= 0) {
        errors.push(`Item ${index + 1} quantity must be a positive whole number`);
      }

      if (rawItem?.unitCost !== undefined && rawItem.unitCost !== null && rawItem.unitCost !== "") {
        unitCost = normalizeMoney(rawItem.unitCost);
        if (unitCost === null) {
          errors.push(`Item ${index + 1} has an invalid unit cost`);
        }
      }

      if (Number.isInteger(productId) && productIds.has(productId)) {
        errors.push(`Product ${productId} appears more than once`);
      }

      productIds.add(productId);
      items.push({ productId, quantity, unitCost });
    });
  }

  return {
    data: { supplierName, referenceNumber, notes, items },
    errors,
  };
}

async function listInventory(req, res) {
  const search = String(req.query.search || "").trim();
  const productWhere = {};

  if (req.user.role === "CASHIER") {
    productWhere.isActive = true;
  }

  if (search) {
    productWhere.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { sku: { contains: search, mode: "insensitive" } },
    ];
  }

  const inventory = await prisma.inventory.findMany({
    where: { product: productWhere },
    include: {
      product: {
        select: {
          id: true,
          sku: true,
          name: true,
          sellingPrice: true,
          costPrice: true,
          isActive: true,
        },
      },
    },
    orderBy: { product: { name: "asc" } },
  });

  let records = inventory.map((record) => ({
    ...record,
    availableQuantity: record.quantity - record.reservedQuantity,
    lowStock:
      record.quantity - record.reservedQuantity <= record.reorderLevel,
  }));

  if (req.query.lowStock === "true") {
    records = records.filter((record) => record.lowStock);
  }

  return res.json({
    success: true,
    data: { inventory: records },
  });
}

async function createStockReceipt(req, res) {
  const { data, errors } = validateReceipt(req.body);

  if (errors.length > 0) {
    return res.status(400).json({ success: false, message: errors[0], errors });
  }

  const products = await prisma.product.findMany({
    where: { id: { in: data.items.map((item) => item.productId) } },
    select: { id: true, isActive: true },
  });

  if (products.length !== data.items.length) {
    return res.status(400).json({
      success: false,
      message: "One or more products do not exist",
    });
  }

  if (products.some((product) => !product.isActive)) {
    return res.status(400).json({
      success: false,
      message: "Stock cannot be received for an inactive product",
    });
  }

  const receipt = await runSerializableTransaction(async (transaction) => {
    const createdReceipt = await transaction.stockReceipt.create({
      data: {
        receiptNumber: makeReceiptNumber(),
        supplierName: data.supplierName,
        referenceNumber: data.referenceNumber,
        notes: data.notes,
        receivedById: req.user.id,
      },
    });

    for (const item of data.items) {
      await transaction.stockReceiptItem.create({
        data: {
          receiptId: createdReceipt.id,
          productId: item.productId,
          quantity: item.quantity,
          unitCost: item.unitCost,
        },
      });

      const inventory = await transaction.inventory.upsert({
        where: { productId: item.productId },
        update: { quantity: { increment: item.quantity } },
        create: {
          productId: item.productId,
          quantity: item.quantity,
          reorderLevel: 5,
        },
      });

      if (item.unitCost !== null) {
        await transaction.product.update({
          where: { id: item.productId },
          data: { costPrice: item.unitCost },
        });
      }

      await transaction.inventoryMovement.create({
        data: {
          productId: item.productId,
          movementType: "STOCK_IN",
          quantityChange: item.quantity,
          balanceAfter: inventory.quantity,
          referenceType: "STOCK_RECEIPT",
          referenceId: createdReceipt.id,
          createdById: req.user.id,
          notes: data.notes,
        },
      });
    }

    await transaction.auditLog.create({
      data: {
        userId: req.user.id,
        action: "RECEIVE_STOCK",
        entityType: "STOCK_RECEIPT",
        entityId: createdReceipt.id,
        details: {
          receiptNumber: createdReceipt.receiptNumber,
          itemCount: data.items.length,
        },
      },
    });

    return transaction.stockReceipt.findUnique({
      where: { id: createdReceipt.id },
      include: {
        receivedBy: {
          select: { id: true, fullName: true, username: true },
        },
        items: {
          include: {
            product: { select: { id: true, sku: true, name: true } },
          },
        },
      },
    });
  });

  return res.status(201).json({
    success: true,
    message: "Stock received successfully",
    data: { receipt },
  });
}

async function listStockReceipts(req, res) {
  const receipts = await prisma.stockReceipt.findMany({
    take: 100,
    include: {
      receivedBy: { select: { id: true, fullName: true, username: true } },
      items: {
        include: { product: { select: { id: true, sku: true, name: true } } },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return res.json({ success: true, data: { receipts } });
}

async function listInventoryMovements(req, res) {
  const productId = req.query.productId ? Number(req.query.productId) : undefined;

  if (productId !== undefined && !Number.isInteger(productId)) {
    return res.status(400).json({ success: false, message: "Invalid product ID" });
  }

  const movements = await prisma.inventoryMovement.findMany({
    where: productId ? { productId } : undefined,
    take: 100,
    include: {
      product: { select: { id: true, sku: true, name: true } },
      createdBy: { select: { id: true, fullName: true, username: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return res.json({ success: true, data: { movements } });
}

module.exports = {
  listInventory,
  createStockReceipt,
  listStockReceipts,
  listInventoryMovements,
};
