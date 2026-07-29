const { randomUUID } = require("crypto");
const prisma = require("../config/prisma");
const HttpError = require("../utils/HttpError");
const { normalizeMoney, normalizeOptionalText } = require("../utils/validation");
const { runSerializableTransaction } = require("../utils/transaction");

const EDITABLE_STATUSES = new Set(["DRAFT", "ORDERED"]);

function makePurchaseOrderNumber() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `PO-${date}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

function makeReceiptNumber() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `GRN-${date}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

function normalizeItems(rawItems, required = true) {
  const errors = [];
  const items = [];
  const productIds = new Set();

  if (rawItems === undefined && !required) return { items: undefined, errors };
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { items, errors: ["At least one purchase-order item is required"] };
  }
  if (rawItems.length > 100) errors.push("A purchase order cannot contain more than 100 items");

  rawItems.forEach((rawItem, index) => {
    const productId = Number(rawItem?.productId);
    const quantity = Number(rawItem?.quantity);
    const unitCost = normalizeMoney(rawItem?.unitCost);
    if (!Number.isInteger(productId) || productId <= 0) errors.push(`Item ${index + 1} has an invalid product ID`);
    if (!Number.isInteger(quantity) || quantity <= 0) errors.push(`Item ${index + 1} quantity must be a positive whole number`);
    if (unitCost === null) errors.push(`Item ${index + 1} has an invalid unit cost`);
    if (Number.isInteger(productId) && productIds.has(productId)) errors.push(`Product ${productId} appears more than once`);
    productIds.add(productId);
    items.push({ productId, quantity, unitCost });
  });

  return { items, errors };
}

function normalizePurchaseOrder(body, partial = false) {
  const data = {};
  const errors = [];

  if (!partial || body.supplierId !== undefined) {
    const supplierId = Number(body.supplierId);
    if (!Number.isInteger(supplierId) || supplierId <= 0) errors.push("Supplier ID is invalid");
    else data.supplierId = supplierId;
  }
  if (body.status !== undefined) {
    const status = String(body.status).toUpperCase();
    if (!EDITABLE_STATUSES.has(status)) errors.push("Status must be DRAFT or ORDERED");
    else data.status = status;
  }
  if (body.expectedAt !== undefined) {
    if (body.expectedAt === null || body.expectedAt === "") data.expectedAt = null;
    else {
      const expectedAt = new Date(body.expectedAt);
      if (Number.isNaN(expectedAt.getTime())) errors.push("Expected date is invalid");
      else data.expectedAt = expectedAt;
    }
  }
  if (body.notes !== undefined) {
    if (body.notes === null || body.notes === "") data.notes = null;
    else {
      const notes = normalizeOptionalText(body.notes, 2000);
      if (!notes) errors.push("Notes cannot exceed 2,000 characters");
      else data.notes = notes;
    }
  }
  const normalizedItems = normalizeItems(body.items, !partial);
  errors.push(...normalizedItems.errors);
  return { data, items: normalizedItems.items, errors };
}

const includePurchaseOrder = {
  supplier: true,
  createdBy: { select: { id: true, fullName: true, username: true } },
  items: {
    include: {
      product: {
        select: { id: true, sku: true, name: true, length: true, width: true, thickness: true },
      },
    },
    orderBy: { id: "asc" },
  },
  receipts: {
    select: { id: true, receiptNumber: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  },
};

function serializePurchaseOrder(order) {
  const total = order.items.reduce(
    (sum, item) => sum + Number(item.unitCost) * item.quantity,
    0
  );
  return {
    ...order,
    totalAmount: total.toFixed(2),
    orderedUnits: order.items.reduce((sum, item) => sum + item.quantity, 0),
    receivedUnits: order.items.reduce((sum, item) => sum + item.receivedQuantity, 0),
  };
}

async function listPurchaseOrders(req, res) {
  const status = req.query.status ? String(req.query.status).toUpperCase() : undefined;
  const supplierId = req.query.supplierId ? Number(req.query.supplierId) : undefined;
  if (status && !new Set(["DRAFT", "ORDERED", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED"]).has(status)) {
    return res.status(400).json({ success: false, message: "Invalid purchase-order status" });
  }
  if (supplierId !== undefined && (!Number.isInteger(supplierId) || supplierId <= 0)) {
    return res.status(400).json({ success: false, message: "Invalid supplier ID" });
  }
  const orders = await prisma.purchaseOrder.findMany({
    where: {
      ...(status ? { status } : {}),
      ...(supplierId ? { supplierId } : {}),
    },
    include: includePurchaseOrder,
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return res.json({ success: true, data: { purchaseOrders: orders.map(serializePurchaseOrder) } });
}

async function createPurchaseOrder(req, res) {
  const { data, items, errors } = normalizePurchaseOrder(req.body);
  if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });

  const order = await runSerializableTransaction(async (transaction) => {
    const [supplier, products] = await Promise.all([
      transaction.supplier.findUnique({ where: { id: data.supplierId } }),
      transaction.product.findMany({ where: { id: { in: items.map((item) => item.productId) }, isActive: true }, select: { id: true } }),
    ]);
    if (!supplier || !supplier.isActive) throw new HttpError(400, "Supplier does not exist or is inactive");
    if (products.length !== items.length) throw new HttpError(400, "One or more products do not exist or are inactive");

    const created = await transaction.purchaseOrder.create({
      data: {
        ...data,
        orderNumber: makePurchaseOrderNumber(),
        createdById: req.user.id,
        items: { create: items },
      },
      include: includePurchaseOrder,
    });
    await transaction.auditLog.create({
      data: {
        userId: req.user.id,
        action: "CREATE_PURCHASE_ORDER",
        entityType: "PURCHASE_ORDER",
        entityId: created.id,
        details: { orderNumber: created.orderNumber, supplierId: created.supplierId, itemCount: items.length },
      },
    });
    return created;
  });

  return res.status(201).json({ success: true, message: "Purchase order created", data: { purchaseOrder: serializePurchaseOrder(order) } });
}

async function updatePurchaseOrder(req, res) {
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ success: false, message: "Invalid purchase-order ID" });
  const { data, items, errors } = normalizePurchaseOrder(req.body, true);
  if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });
  if (!Object.keys(data).length && items === undefined) {
    return res.status(400).json({ success: false, message: "Provide at least one purchase-order field to update" });
  }

  const order = await runSerializableTransaction(async (transaction) => {
    const existing = await transaction.purchaseOrder.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!existing) throw new HttpError(404, "Purchase order not found");
    if (!EDITABLE_STATUSES.has(existing.status) || existing.items.some((item) => item.receivedQuantity > 0)) {
      throw new HttpError(409, "Only an unreceived draft or ordered purchase order can be edited");
    }
    if (data.supplierId !== undefined) {
      const supplier = await transaction.supplier.findUnique({ where: { id: data.supplierId } });
      if (!supplier || !supplier.isActive) throw new HttpError(400, "Supplier does not exist or is inactive");
    }
    if (items !== undefined) {
      const products = await transaction.product.findMany({
        where: { id: { in: items.map((item) => item.productId) }, isActive: true },
        select: { id: true },
      });
      if (products.length !== items.length) throw new HttpError(400, "One or more products do not exist or are inactive");
      await transaction.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: orderId } });
      await transaction.purchaseOrderItem.createMany({ data: items.map((item) => ({ ...item, purchaseOrderId: orderId })) });
    }
    await transaction.purchaseOrder.update({ where: { id: orderId }, data });
    await transaction.auditLog.create({
      data: {
        userId: req.user.id,
        action: "UPDATE_PURCHASE_ORDER",
        entityType: "PURCHASE_ORDER",
        entityId: orderId,
        details: { fields: [...Object.keys(data), ...(items !== undefined ? ["items"] : [])] },
      },
    });
    return transaction.purchaseOrder.findUnique({ where: { id: orderId }, include: includePurchaseOrder });
  });
  return res.json({ success: true, message: "Purchase order updated", data: { purchaseOrder: serializePurchaseOrder(order) } });
}

function normalizeReceiptItems(rawItems) {
  const errors = [];
  if (!Array.isArray(rawItems) || rawItems.length === 0) return { items: [], errors: ["At least one received item is required"] };
  if (rawItems.length > 100) errors.push("A receipt cannot contain more than 100 items");
  const productIds = new Set();
  const items = rawItems.map((rawItem, index) => {
    const productId = Number(rawItem?.productId);
    const quantity = Number(rawItem?.quantity);
    if (!Number.isInteger(productId) || productId <= 0) errors.push(`Item ${index + 1} has an invalid product ID`);
    if (!Number.isInteger(quantity) || quantity <= 0) errors.push(`Item ${index + 1} quantity must be a positive whole number`);
    if (Number.isInteger(productId) && productIds.has(productId)) errors.push(`Product ${productId} appears more than once`);
    productIds.add(productId);
    return { productId, quantity };
  });
  return { items, errors };
}

async function receivePurchaseOrder(req, res) {
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ success: false, message: "Invalid purchase-order ID" });
  const { items, errors } = normalizeReceiptItems(req.body.items);
  const referenceNumber = normalizeOptionalText(req.body.referenceNumber, 150);
  const notes = normalizeOptionalText(req.body.notes, 2000);
  if (req.body.referenceNumber && !referenceNumber) errors.push("Reference number cannot exceed 150 characters");
  if (req.body.notes && !notes) errors.push("Notes cannot exceed 2,000 characters");
  if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });

  const result = await runSerializableTransaction(async (transaction) => {
    const order = await transaction.purchaseOrder.findUnique({
      where: { id: orderId },
      include: { supplier: true, items: true },
    });
    if (!order) throw new HttpError(404, "Purchase order not found");
    if (["DRAFT", "CANCELLED", "RECEIVED"].includes(order.status)) {
      throw new HttpError(409, "This purchase order cannot receive stock in its current status");
    }
    const orderItems = new Map(order.items.map((item) => [item.productId, item]));
    for (const item of items) {
      const ordered = orderItems.get(item.productId);
      if (!ordered) throw new HttpError(400, `Product ${item.productId} is not on this purchase order`);
      const remaining = ordered.quantity - ordered.receivedQuantity;
      if (item.quantity > remaining) throw new HttpError(409, `Only ${remaining} unit(s) remain to receive for product ${item.productId}`);
    }

    const receipt = await transaction.stockReceipt.create({
      data: {
        receiptNumber: makeReceiptNumber(),
        supplierId: order.supplierId,
        supplierName: order.supplier.name,
        purchaseOrderId: order.id,
        referenceNumber,
        notes,
        receivedById: req.user.id,
      },
    });

    for (const item of items) {
      const ordered = orderItems.get(item.productId);
      await transaction.stockReceiptItem.create({
        data: { receiptId: receipt.id, productId: item.productId, quantity: item.quantity, unitCost: ordered.unitCost },
      });
      const inventory = await transaction.inventory.upsert({
        where: { productId: item.productId },
        update: { quantity: { increment: item.quantity } },
        create: { productId: item.productId, quantity: item.quantity, reorderLevel: 5 },
      });
      await transaction.product.update({ where: { id: item.productId }, data: { costPrice: ordered.unitCost } });
      await transaction.purchaseOrderItem.update({
        where: { id: ordered.id },
        data: { receivedQuantity: { increment: item.quantity } },
      });
      await transaction.inventoryMovement.create({
        data: {
          productId: item.productId,
          movementType: "STOCK_IN",
          quantityChange: item.quantity,
          balanceAfter: inventory.quantity,
          referenceType: "PURCHASE_ORDER",
          referenceId: order.id,
          createdById: req.user.id,
          notes,
        },
      });
    }

    const refreshedItems = await transaction.purchaseOrderItem.findMany({ where: { purchaseOrderId: order.id } });
    const allReceived = refreshedItems.every((item) => item.receivedQuantity === item.quantity);
    await transaction.purchaseOrder.update({
      where: { id: order.id },
      data: { status: allReceived ? "RECEIVED" : "PARTIALLY_RECEIVED" },
    });
    await transaction.auditLog.create({
      data: {
        userId: req.user.id,
        action: "RECEIVE_PURCHASE_ORDER",
        entityType: "PURCHASE_ORDER",
        entityId: order.id,
        details: { receiptNumber: receipt.receiptNumber, itemCount: items.length, completed: allReceived },
      },
    });
    return {
      receipt: await transaction.stockReceipt.findUnique({
        where: { id: receipt.id },
        include: {
          supplier: true,
          receivedBy: { select: { id: true, fullName: true, username: true } },
          items: { include: { product: true } },
        },
      }),
      purchaseOrder: await transaction.purchaseOrder.findUnique({ where: { id: order.id }, include: includePurchaseOrder }),
    };
  });

  return res.status(201).json({
    success: true,
    message: "Purchase-order stock received",
    data: { receipt: result.receipt, purchaseOrder: serializePurchaseOrder(result.purchaseOrder) },
  });
}

async function cancelPurchaseOrder(req, res) {
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ success: false, message: "Invalid purchase-order ID" });
  const reason = normalizeOptionalText(req.body.reason, 500);
  if (req.body.reason && !reason) return res.status(400).json({ success: false, message: "Cancellation reason cannot exceed 500 characters" });

  const order = await runSerializableTransaction(async (transaction) => {
    const existing = await transaction.purchaseOrder.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!existing) throw new HttpError(404, "Purchase order not found");
    if (existing.status === "CANCELLED") return existing;
    if (existing.status === "RECEIVED" || existing.items.some((item) => item.receivedQuantity > 0)) {
      throw new HttpError(409, "A purchase order with received stock cannot be cancelled");
    }
    const cancelled = await transaction.purchaseOrder.update({
      where: { id: orderId },
      data: { status: "CANCELLED", cancelledAt: new Date(), notes: reason ? [existing.notes, `Cancellation: ${reason}`].filter(Boolean).join("\n") : existing.notes },
      include: includePurchaseOrder,
    });
    await transaction.auditLog.create({
      data: { userId: req.user.id, action: "CANCEL_PURCHASE_ORDER", entityType: "PURCHASE_ORDER", entityId: orderId, details: { reason } },
    });
    return cancelled;
  });
  return res.json({ success: true, message: "Purchase order cancelled", data: { purchaseOrder: serializePurchaseOrder(order) } });
}

module.exports = {
  listPurchaseOrders,
  createPurchaseOrder,
  updatePurchaseOrder,
  receivePurchaseOrder,
  cancelPurchaseOrder,
  normalizePurchaseOrder,
};
