const { randomUUID } = require("crypto");
const prisma = require("../config/prisma");
const HttpError = require("../utils/HttpError");
const { normalizeMoney } = require("../utils/validation");
const { runSerializableTransaction } = require("../utils/transaction");

const RECEIPT_QUALITIES = new Set(["ACCEPTED", "PARTIAL_DAMAGE", "REJECTED"]);
const ADJUSTMENT_TYPES = new Set(["DAMAGE_OUT", "RETURN_IN"]);

function makeReceiptNumber() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `GRN-${date}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

function makeBatchNumber(receiptNumber, itemIndex) {
  return `${receiptNumber}-B${String(itemIndex + 1).padStart(2, "0")}`;
}

function makeTransferNumber() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `MOVE-${date}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

function cleanText(value, limit) {
  const normalized = String(value || "").trim().replace(/\s+/g, " ");
  return normalized && normalized.length <= limit ? normalized : null;
}

function optionalText(value, limit) {
  if (value === undefined || value === null || value === "") return null;
  return cleanText(value, limit);
}

function validateReceipt(body) {
  const supplierName = String(body.supplierName || "").trim() || null;
  const supplierId =
    body.supplierId === undefined || body.supplierId === null || body.supplierId === ""
      ? null
      : Number(body.supplierId);
  const referenceNumber = String(body.referenceNumber || "").trim() || null;
  const notes = String(body.notes || "").trim() || null;
  const containerNumber = optionalText(body.containerNumber, 100);
  const vehiclePlate = optionalText(body.vehiclePlate, 80);
  const qualityStatus = String(body.qualityStatus || "ACCEPTED").trim().toUpperCase();
  const inspectionNotes = optionalText(body.inspectionNotes, 2000);
  const rawItems = body.items;
  const errors = [];

  if (supplierName && supplierName.length > 150) {
    errors.push("Supplier name cannot exceed 150 characters");
  }
  if (supplierId !== null && (!Number.isInteger(supplierId) || supplierId <= 0)) {
    errors.push("Supplier ID is invalid");
  }

  if (referenceNumber && referenceNumber.length > 150) {
    errors.push("Reference number cannot exceed 150 characters");
  }

  if (notes && notes.length > 2000) {
    errors.push("Notes cannot exceed 2,000 characters");
  }
  if ((body.containerNumber && !containerNumber) || (body.vehiclePlate && !vehiclePlate) || (body.inspectionNotes && !inspectionNotes)) {
    errors.push("One of the receiving details is too long");
  }
  if (!RECEIPT_QUALITIES.has(qualityStatus)) errors.push("Choose a valid receiving condition");

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
      const damagedQuantity = Number(rawItem?.damagedQuantity || 0);
      let unitCost = null;
      const locationId = rawItem?.locationId === undefined || rawItem?.locationId === null || rawItem?.locationId === "" ? null : Number(rawItem.locationId);
      const batchNumber = optionalText(rawItem?.batchNumber, 120);
      const origin = optionalText(rawItem?.origin, 120);
      const color = optionalText(rawItem?.color, 120);
      const grade = optionalText(rawItem?.grade, 80);

      if (!Number.isInteger(productId) || productId <= 0) {
        errors.push(`Item ${index + 1} has an invalid product ID`);
      }

      if (!Number.isInteger(quantity) || quantity < 0 || (quantity === 0 && qualityStatus !== "REJECTED")) {
        errors.push(`Item ${index + 1} accepted quantity must be ${qualityStatus === "REJECTED" ? "zero or a positive" : "a positive"} whole number`);
      }
      if (!Number.isInteger(damagedQuantity) || damagedQuantity < 0) {
        errors.push(`Item ${index + 1} damaged quantity must be zero or a positive whole number`);
      }
      if (locationId !== null && (!Number.isInteger(locationId) || locationId <= 0)) {
        errors.push(`Item ${index + 1} has an invalid warehouse location`);
      }
      if ((rawItem?.batchNumber && !batchNumber) || (rawItem?.origin && !origin) || (rawItem?.color && !color) || (rawItem?.grade && !grade)) {
        errors.push(`Item ${index + 1} has an invalid batch detail`);
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
      items.push({ productId, quantity, damagedQuantity, unitCost, locationId, batchNumber, origin, color, grade });
    });
  }

  return {
    data: { supplierId, supplierName, referenceNumber, notes, containerNumber, vehiclePlate, qualityStatus, inspectionNotes, items },
    errors,
  };
}

async function listInventory(req, res) {
  const search = String(req.query.search || "").trim();
  const productWhere = { isActive: true };

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
          length: true,
          width: true,
          thickness: true,
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

  const locationIds = [...new Set(data.items.map((item) => item.locationId).filter(Boolean))];
  const [products, supplier, locations] = await Promise.all([
    prisma.product.findMany({
      where: { id: { in: data.items.map((item) => item.productId) } },
      select: { id: true, isActive: true },
    }),
    data.supplierId
      ? prisma.supplier.findUnique({ where: { id: data.supplierId } })
      : Promise.resolve(null),
    locationIds.length
      ? prisma.inventoryLocation.findMany({ where: { id: { in: locationIds }, isActive: true }, select: { id: true } })
      : Promise.resolve([]),
  ]);

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
  if (data.supplierId && (!supplier || !supplier.isActive)) {
    return res.status(400).json({
      success: false,
      message: "Supplier does not exist or is inactive",
    });
  }
  if (locations.length !== locationIds.length) {
    return res.status(400).json({ success: false, message: "One or more warehouse locations do not exist or are inactive" });
  }

  const receipt = await runSerializableTransaction(async (transaction) => {
    const createdReceipt = await transaction.stockReceipt.create({
      data: {
        receiptNumber: makeReceiptNumber(),
        supplierId: supplier?.id || null,
        supplierName: supplier?.name || data.supplierName,
        referenceNumber: data.referenceNumber,
        containerNumber: data.containerNumber,
        vehiclePlate: data.vehiclePlate,
        qualityStatus: data.qualityStatus,
        inspectionNotes: data.inspectionNotes,
        notes: data.notes,
        receivedById: req.user.id,
      },
    });

    for (const [index, item] of data.items.entries()) {
      const createdItem = await transaction.stockReceiptItem.create({
        data: {
          receiptId: createdReceipt.id,
          productId: item.productId,
          quantity: item.quantity,
          unitCost: item.unitCost,
          damagedQuantity: item.damagedQuantity,
        },
      });

      const batch = await transaction.stockBatch.create({
        data: {
          batchNumber: item.batchNumber || makeBatchNumber(createdReceipt.receiptNumber, index),
          productId: item.productId,
          receiptId: createdReceipt.id,
          supplierId: supplier?.id || null,
          locationId: item.locationId,
          origin: item.origin,
          color: item.color,
          grade: item.grade,
          originalQuantity: item.quantity,
          availableQuantity: item.quantity,
          notes: data.notes,
        },
      });
      await transaction.stockReceiptItem.update({ where: { id: createdItem.id }, data: { batchId: batch.id } });

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

      if (item.locationId) {
        await transaction.inventoryLocationBalance.upsert({
          where: { locationId_productId: { locationId: item.locationId, productId: item.productId } },
          create: { locationId: item.locationId, productId: item.productId, quantity: item.quantity },
          update: { quantity: { increment: item.quantity } },
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
          damagedUnits: data.items.reduce((total, item) => total + item.damagedQuantity, 0),
          qualityStatus: data.qualityStatus,
        },
      },
    });

    return transaction.stockReceipt.findUnique({
      where: { id: createdReceipt.id },
      include: {
        receivedBy: {
          select: { id: true, fullName: true, username: true },
        },
        supplier: true,
        items: {
          include: {
            product: {
              select: {
                id: true,
                sku: true,
                name: true,
                length: true,
                width: true,
                thickness: true,
              },
            },
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
      supplier: true,
      items: {
        include: {
          batch: { include: { location: true } },
          product: {
            select: {
              id: true,
              sku: true,
              name: true,
              length: true,
              width: true,
              thickness: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return res.json({ success: true, data: { receipts } });
}

async function listInventoryMovements(req, res) {
  const productId = req.query.productId ? Number(req.query.productId) : undefined;

  if (
    productId !== undefined &&
    (!Number.isInteger(productId) || productId <= 0)
  ) {
    return res.status(400).json({ success: false, message: "Invalid product ID" });
  }

  const movements = await prisma.inventoryMovement.findMany({
    where: productId !== undefined ? { productId } : undefined,
    take: 100,
    include: {
      product: {
        select: {
          id: true,
          sku: true,
          name: true,
          length: true,
          width: true,
          thickness: true,
        },
      },
      createdBy: { select: { id: true, fullName: true, username: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return res.json({ success: true, data: { movements } });
}

async function listLocations(req, res) {
  const locations = await prisma.inventoryLocation.findMany({
    where: req.query.active === "all" ? undefined : { isActive: true },
    include: {
      balances: { where: { quantity: { gt: 0 } }, include: { product: { select: { id: true, sku: true, name: true, length: true, width: true, thickness: true } } } },
      _count: { select: { batches: true } },
    },
    orderBy: [{ warehouse: "asc" }, { code: "asc" }],
  });
  return res.json({ success: true, data: { locations } });
}

async function createLocation(req, res) {
  const code = cleanText(req.body.code, 80)?.toUpperCase();
  const name = cleanText(req.body.name, 120);
  const warehouse = optionalText(req.body.warehouse, 120);
  const rowLabel = optionalText(req.body.rowLabel, 60);
  const rack = optionalText(req.body.rack, 60);
  const slot = optionalText(req.body.slot, 60);
  if (!code || !name) return res.status(400).json({ success: false, message: "Enter a location code and name" });
  try {
    const location = await runSerializableTransaction(async (transaction) => {
      const created = await transaction.inventoryLocation.create({ data: { code, name, warehouse, rowLabel, rack, slot } });
      await transaction.auditLog.create({ data: { userId: req.user.id, action: "CREATE_INVENTORY_LOCATION", entityType: "INVENTORY_LOCATION", entityId: created.id, details: { code, name } } });
      return created;
    });
    return res.status(201).json({ success: true, data: { location } });
  } catch (error) {
    if (error.code === "P2002") return res.status(409).json({ success: false, message: "That warehouse location code already exists" });
    throw error;
  }
}

async function updateLocation(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, message: "Invalid location ID" });
  const data = {};
  if (req.body.code !== undefined) { const code = cleanText(req.body.code, 80); if (!code) return res.status(400).json({ success: false, message: "Enter a valid location code" }); data.code = code.toUpperCase(); }
  if (req.body.name !== undefined) { const name = cleanText(req.body.name, 120); if (!name) return res.status(400).json({ success: false, message: "Enter a valid location name" }); data.name = name; }
  for (const [field, limit] of [["warehouse", 120], ["rowLabel", 60], ["rack", 60], ["slot", 60]]) {
    if (req.body[field] !== undefined) { const value = optionalText(req.body[field], limit); if (req.body[field] && !value) return res.status(400).json({ success: false, message: "One of the location fields is too long" }); data[field] = value; }
  }
  if (req.body.isActive !== undefined) data.isActive = Boolean(req.body.isActive);
  if (!Object.keys(data).length) return res.status(400).json({ success: false, message: "Provide a location change" });
  try {
    const location = await runSerializableTransaction(async (transaction) => {
      const existing = await transaction.inventoryLocation.findUnique({ where: { id } });
      if (!existing) return null;
      const updated = await transaction.inventoryLocation.update({ where: { id }, data });
      await transaction.auditLog.create({ data: { userId: req.user.id, action: "UPDATE_INVENTORY_LOCATION", entityType: "INVENTORY_LOCATION", entityId: id, details: { fields: Object.keys(data) } } });
      return updated;
    });
    if (!location) return res.status(404).json({ success: false, message: "Warehouse location not found" });
    return res.json({ success: true, data: { location } });
  } catch (error) {
    if (error.code === "P2002") return res.status(409).json({ success: false, message: "That warehouse location code already exists" });
    throw error;
  }
}

async function listBatches(req, res) {
  const batches = await prisma.stockBatch.findMany({
    where: {
      ...(req.query.productId ? { productId: Number(req.query.productId) } : {}),
      ...(req.query.available === "true" ? { availableQuantity: { gt: 0 } } : {}),
    },
    include: {
      product: { select: { id: true, sku: true, name: true, length: true, width: true, thickness: true } },
      supplier: { select: { id: true, name: true } },
      location: { select: { id: true, code: true, name: true } },
      receipt: { select: { id: true, receiptNumber: true, createdAt: true } },
    },
    take: 200,
    orderBy: { createdAt: "desc" },
  });
  return res.json({ success: true, data: { batches } });
}

async function adjustInventory(req, res) {
  const productId = Number(req.body.productId);
  const quantity = Number(req.body.quantity);
  const type = String(req.body.type || "").trim().toUpperCase();
  const reason = cleanText(req.body.reason, 1000);
  const locationId = req.body.locationId ? Number(req.body.locationId) : null;
  const batchId = req.body.batchId ? Number(req.body.batchId) : null;
  if (!Number.isInteger(productId) || productId <= 0 || !Number.isInteger(quantity) || quantity <= 0 || !ADJUSTMENT_TYPES.has(type) || !reason) {
    return res.status(400).json({ success: false, message: "Choose a product, return or damage type, quantity, and reason" });
  }
  if ((locationId !== null && (!Number.isInteger(locationId) || locationId <= 0)) || (batchId !== null && (!Number.isInteger(batchId) || batchId <= 0))) {
    return res.status(400).json({ success: false, message: "Invalid batch or warehouse location" });
  }
  const adjustment = await runSerializableTransaction(async (transaction) => {
    const [inventory, batch, location] = await Promise.all([
      transaction.inventory.findUnique({ where: { productId }, include: { product: { select: { id: true, name: true, isActive: true } } } }),
      batchId ? transaction.stockBatch.findUnique({ where: { id: batchId } }) : Promise.resolve(null),
      locationId ? transaction.inventoryLocation.findUnique({ where: { id: locationId } }) : Promise.resolve(null),
    ]);
    if (!inventory || !inventory.product.isActive) throw new HttpError(404, "Active product inventory was not found");
    if (batchId && (!batch || batch.productId !== productId)) throw new HttpError(400, "That batch does not belong to this product");
    if (locationId && (!location || !location.isActive)) throw new HttpError(400, "Warehouse location was not found");
    const subtracting = type === "DAMAGE_OUT";
    if (subtracting && inventory.quantity - quantity < inventory.reservedQuantity) throw new HttpError(409, `Only ${Math.max(0, inventory.quantity - inventory.reservedQuantity)} unreserved unit(s) can be marked damaged`);
    if (subtracting && batch && batch.availableQuantity < quantity) throw new HttpError(409, "The selected batch does not have enough available units");
    let locationBalance = null;
    if (locationId) locationBalance = await transaction.inventoryLocationBalance.findUnique({ where: { locationId_productId: { locationId, productId } } });
    if (subtracting && locationId && (!locationBalance || locationBalance.quantity < quantity)) throw new HttpError(409, "The selected warehouse location does not have enough units");
    const updatedInventory = await transaction.inventory.update({ where: { productId }, data: { quantity: subtracting ? { decrement: quantity } : { increment: quantity } } });
    if (batch) await transaction.stockBatch.update({ where: { id: batch.id }, data: { availableQuantity: subtracting ? { decrement: quantity } : { increment: quantity } } });
    if (locationId) {
      await transaction.inventoryLocationBalance.upsert({
        where: { locationId_productId: { locationId, productId } },
        create: { locationId, productId, quantity: subtracting ? 0 : quantity },
        update: { quantity: subtracting ? { decrement: quantity } : { increment: quantity } },
      });
    }
    const movement = await transaction.inventoryMovement.create({
      data: { productId, movementType: type, quantityChange: subtracting ? -quantity : quantity, balanceAfter: updatedInventory.quantity, referenceType: "STOCK_CONDITION", createdById: req.user.id, notes: reason },
    });
    await transaction.auditLog.create({ data: { userId: req.user.id, action: type, entityType: "INVENTORY_MOVEMENT", entityId: movement.id, details: { productId, quantity, batchId, locationId, reason } } });
    return movement;
  });
  return res.status(201).json({ success: true, message: type === "DAMAGE_OUT" ? "Damaged stock removed and recorded" : "Returned stock added and recorded", data: { adjustment } });
}

async function listAuditLogs(req, res) {
  const logs = await prisma.auditLog.findMany({
    take: Math.min(Math.max(Number(req.query.limit) || 100, 1), 200),
    include: { user: { select: { id: true, fullName: true, username: true, role: true } } },
    orderBy: { createdAt: "desc" },
  });
  return res.json({ success: true, data: { logs } });
}

function normalizeTransfer(body) {
  const fromLocationId = Number(body.fromLocationId);
  const toLocationId = Number(body.toLocationId);
  const notes = optionalText(body.notes, 2000);
  const errors = [];
  if (!Number.isInteger(fromLocationId) || fromLocationId <= 0) errors.push("Choose a source warehouse location");
  if (!Number.isInteger(toLocationId) || toLocationId <= 0) errors.push("Choose a destination warehouse location");
  if (fromLocationId === toLocationId) errors.push("Source and destination locations must be different");
  if (body.notes && !notes) errors.push("Transfer note cannot exceed 2,000 characters");
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 100) errors.push("A transfer needs between 1 and 100 stock lines");
  const seen = new Set();
  const items = Array.isArray(body.items) ? body.items.map((rawItem, index) => {
    const productId = Number(rawItem?.productId);
    const quantity = Number(rawItem?.quantity);
    const batchId = rawItem?.batchId === undefined || rawItem?.batchId === null || rawItem?.batchId === "" ? null : Number(rawItem.batchId);
    if (!Number.isInteger(productId) || productId <= 0) errors.push(`Transfer line ${index + 1} has an invalid product`);
    if (!Number.isInteger(quantity) || quantity <= 0) errors.push(`Transfer line ${index + 1} quantity must be a positive whole number`);
    if (batchId !== null && (!Number.isInteger(batchId) || batchId <= 0)) errors.push(`Transfer line ${index + 1} has an invalid batch`);
    const key = `${productId}:${batchId ?? "none"}`;
    if (seen.has(key)) errors.push(`Transfer line ${index + 1} repeats a product or batch`);
    seen.add(key);
    return { productId, quantity, batchId };
  }) : [];
  return { data: { fromLocationId, toLocationId, notes, items }, errors };
}

const transferInclude = {
  fromLocation: { select: { id: true, code: true, name: true } },
  toLocation: { select: { id: true, code: true, name: true } },
  transferredBy: { select: { id: true, fullName: true, username: true } },
  items: { include: { product: { select: { id: true, sku: true, name: true, length: true, width: true, thickness: true } }, batch: { select: { id: true, batchNumber: true } } } },
};

async function listStockTransfers(req, res) {
  const transfers = await prisma.stockTransfer.findMany({ take: 100, include: transferInclude, orderBy: { createdAt: "desc" } });
  return res.json({ success: true, data: { transfers } });
}

async function createStockTransfer(req, res) {
  const { data, errors } = normalizeTransfer(req.body);
  if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });
  const transfer = await runSerializableTransaction(async (transaction) => {
    const productIds = [...new Set(data.items.map((item) => item.productId))];
    const [locations, inventory, batches, sourceBalances] = await Promise.all([
      transaction.inventoryLocation.findMany({ where: { id: { in: [data.fromLocationId, data.toLocationId] }, isActive: true } }),
      transaction.inventory.findMany({ where: { productId: { in: productIds } }, include: { product: { select: { id: true, isActive: true, name: true } } } }),
      transaction.stockBatch.findMany({ where: { id: { in: data.items.map((item) => item.batchId).filter(Boolean) } } }),
      transaction.inventoryLocationBalance.findMany({ where: { locationId: data.fromLocationId, productId: { in: productIds } } }),
    ]);
    if (locations.length !== 2) throw new HttpError(400, "Source or destination warehouse location is unavailable");
    if (inventory.length !== productIds.length || inventory.some((record) => !record.product.isActive)) throw new HttpError(400, "One or more transfer products do not have active inventory");
    const inventoryByProduct = new Map(inventory.map((record) => [record.productId, record]));
    const batchesById = new Map(batches.map((batch) => [batch.id, batch]));
    const requiredByProduct = data.items.reduce((totals, item) => totals.set(item.productId, (totals.get(item.productId) || 0) + item.quantity), new Map());
    const sourceByProduct = new Map(sourceBalances.map((balance) => [balance.productId, balance]));
    for (const [productId, quantity] of requiredByProduct) {
      const source = sourceByProduct.get(productId);
      if (!source || source.quantity < quantity) {
        const product = inventoryByProduct.get(productId).product;
        throw new HttpError(409, `${product.name} does not have ${quantity} unit(s) at the selected source location`);
      }
    }
    for (const item of data.items) {
      if (!item.batchId) continue;
      const batch = batchesById.get(item.batchId);
      if (!batch || batch.productId !== item.productId) throw new HttpError(400, "A selected batch does not belong to its transfer product");
      if (batch.locationId !== data.fromLocationId) throw new HttpError(409, "The selected batch is not currently assigned to the source location");
      if (batch.availableQuantity < item.quantity) throw new HttpError(409, "The selected batch does not have enough available units");
    }

    const created = await transaction.stockTransfer.create({ data: { transferNumber: makeTransferNumber(), fromLocationId: data.fromLocationId, toLocationId: data.toLocationId, transferredById: req.user.id, notes: data.notes } });
    for (const item of data.items) {
      const inventoryRecord = inventoryByProduct.get(item.productId);
      await transaction.stockTransferItem.create({ data: { transferId: created.id, productId: item.productId, batchId: item.batchId, quantity: item.quantity } });
      if (item.batchId) {
        const batch = batchesById.get(item.batchId);
        if (batch.availableQuantity === item.quantity) await transaction.stockBatch.update({ where: { id: batch.id }, data: { locationId: data.toLocationId } });
      }
      await transaction.inventoryMovement.create({ data: { productId: item.productId, movementType: "TRANSFER_OUT", quantityChange: 0, balanceAfter: inventoryRecord.quantity, referenceType: "STOCK_TRANSFER", referenceId: created.id, createdById: req.user.id, notes: `Moved ${item.quantity} from location ${data.fromLocationId} to ${data.toLocationId}` } });
      await transaction.inventoryMovement.create({ data: { productId: item.productId, movementType: "TRANSFER_IN", quantityChange: 0, balanceAfter: inventoryRecord.quantity, referenceType: "STOCK_TRANSFER", referenceId: created.id, createdById: req.user.id, notes: `Received ${item.quantity} from location ${data.fromLocationId} to ${data.toLocationId}` } });
    }
    for (const [productId, quantity] of requiredByProduct) {
      await transaction.inventoryLocationBalance.update({ where: { locationId_productId: { locationId: data.fromLocationId, productId } }, data: { quantity: { decrement: quantity } } });
      await transaction.inventoryLocationBalance.upsert({ where: { locationId_productId: { locationId: data.toLocationId, productId } }, create: { locationId: data.toLocationId, productId, quantity }, update: { quantity: { increment: quantity } } });
    }
    await transaction.auditLog.create({ data: { userId: req.user.id, action: "TRANSFER_STOCK", entityType: "STOCK_TRANSFER", entityId: created.id, details: { fromLocationId: data.fromLocationId, toLocationId: data.toLocationId, items: data.items } } });
    return transaction.stockTransfer.findUnique({ where: { id: created.id }, include: transferInclude });
  });
  return res.status(201).json({ success: true, message: "Stock transferred between warehouse locations", data: { transfer } });
}

module.exports = {
  listInventory,
  createStockReceipt,
  listStockReceipts,
  listInventoryMovements,
  listLocations,
  createLocation,
  updateLocation,
  listBatches,
  adjustInventory,
  listAuditLogs,
  listStockTransfers,
  createStockTransfer,
  normalizeTransfer,
};
