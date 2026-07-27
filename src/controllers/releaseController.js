const { randomUUID } = require("crypto");
const prisma = require("../config/prisma");
const HttpError = require("../utils/HttpError");
const { runSerializableTransaction } = require("../utils/transaction");

function makeReleaseNumber() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `REL-${date}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

function validateReleaseRequest(body) {
  const saleId = Number(body.saleId);
  const notes = String(body.notes || "").trim() || null;
  const rawItems = body.items;
  const errors = [];
  const items = [];
  const saleItemIds = new Set();

  if (!Number.isInteger(saleId) || saleId <= 0) {
    errors.push("A valid sale ID is required");
  }

  if (notes && notes.length > 2000) {
    errors.push("Release notes cannot exceed 2,000 characters");
  }

  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    errors.push("At least one sale item must be selected for release");
  } else if (rawItems.length > 100) {
    errors.push("A release cannot contain more than 100 items");
  }

  if (Array.isArray(rawItems)) {
    rawItems.forEach((rawItem, index) => {
      const saleItemId = Number(rawItem?.saleItemId);
      const quantity = Number(rawItem?.quantity);

      if (!Number.isInteger(saleItemId) || saleItemId <= 0) {
        errors.push(`Release item ${index + 1} has an invalid sale-item ID`);
      }

      if (!Number.isInteger(quantity) || quantity <= 0) {
        errors.push(`Release item ${index + 1} quantity must be a positive whole number`);
      }

      if (Number.isInteger(saleItemId) && saleItemIds.has(saleItemId)) {
        errors.push(`Sale item ${saleItemId} appears more than once`);
      }

      saleItemIds.add(saleItemId);
      items.push({ saleItemId, quantity });
    });
  }

  return { data: { saleId, notes, items }, errors };
}

async function listPendingReleases(req, res) {
  const sales = await prisma.sale.findMany({
    where: {
      status: { in: ["PENDING_RELEASE", "PARTIALLY_RELEASED"] },
    },
    include: {
      cashier: { select: { id: true, fullName: true, username: true } },
      payments: true,
      items: {
        include: {
          product: {
            include: { inventory: true },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const pendingSales = sales.map((sale) => ({
    ...sale,
    items: sale.items.map((item) => ({
      ...item,
      remainingQuantity: item.quantity - item.releasedQuantity,
      physicalStock: item.product.inventory?.quantity || 0,
    })),
  }));

  return res.json({ success: true, data: { sales: pendingSales } });
}

async function createRelease(req, res) {
  const { data, errors } = validateReleaseRequest(req.body);

  if (errors.length > 0) {
    return res.status(400).json({ success: false, message: errors[0], errors });
  }

  const release = await runSerializableTransaction(async (transaction) => {
    const sale = await transaction.sale.findUnique({
      where: { id: data.saleId },
      include: {
        items: {
          include: {
            product: { include: { inventory: true } },
          },
        },
      },
    });

    if (!sale) {
      throw new HttpError(404, "Sale not found");
    }

    if (!["PENDING_RELEASE", "PARTIALLY_RELEASED"].includes(sale.status)) {
      throw new HttpError(409, "This sale is not awaiting inventory release");
    }

    const saleItemsById = new Map(sale.items.map((item) => [item.id, item]));
    const releaseQuantityByItemId = new Map();

    for (const requestedItem of data.items) {
      const saleItem = saleItemsById.get(requestedItem.saleItemId);

      if (!saleItem) {
        throw new HttpError(
          400,
          `Sale item ${requestedItem.saleItemId} does not belong to this sale`
        );
      }

      const remainingQuantity = saleItem.quantity - saleItem.releasedQuantity;

      if (requestedItem.quantity > remainingQuantity) {
        throw new HttpError(
          409,
          `Only ${remainingQuantity} unit(s) of ${saleItem.product.name} remain to be released`
        );
      }

      const inventory = saleItem.product.inventory;

      if (!inventory || inventory.quantity < requestedItem.quantity) {
        throw new HttpError(
          409,
          `Physical stock for ${saleItem.product.name} is insufficient`
        );
      }

      if (inventory.reservedQuantity < requestedItem.quantity) {
        throw new HttpError(
          409,
          `Reserved stock for ${saleItem.product.name} is inconsistent`
        );
      }

      releaseQuantityByItemId.set(saleItem.id, requestedItem.quantity);
    }

    const createdRelease = await transaction.inventoryRelease.create({
      data: {
        saleId: sale.id,
        releasedById: req.user.id,
        releaseNumber: makeReleaseNumber(),
        notes: data.notes,
      },
    });

    for (const requestedItem of data.items) {
      const saleItem = saleItemsById.get(requestedItem.saleItemId);

      await transaction.inventoryReleaseItem.create({
        data: {
          releaseId: createdRelease.id,
          saleItemId: saleItem.id,
          quantity: requestedItem.quantity,
        },
      });

      await transaction.saleItem.update({
        where: { id: saleItem.id },
        data: { releasedQuantity: { increment: requestedItem.quantity } },
      });

      const inventory = await transaction.inventory.update({
        where: { productId: saleItem.productId },
        data: {
          quantity: { decrement: requestedItem.quantity },
          reservedQuantity: { decrement: requestedItem.quantity },
        },
      });

      await transaction.inventoryMovement.create({
        data: {
          productId: saleItem.productId,
          movementType: "RELEASE",
          quantityChange: -requestedItem.quantity,
          balanceAfter: inventory.quantity,
          referenceType: "INVENTORY_RELEASE",
          referenceId: createdRelease.id,
          createdById: req.user.id,
          notes: data.notes,
        },
      });
    }

    const isCompleted = sale.items.every((item) => {
      const releasingNow = releaseQuantityByItemId.get(item.id) || 0;
      return item.releasedQuantity + releasingNow === item.quantity;
    });

    await transaction.sale.update({
      where: { id: sale.id },
      data: {
        status: isCompleted ? "COMPLETED" : "PARTIALLY_RELEASED",
        completedAt: isCompleted ? new Date() : null,
      },
    });

    await transaction.auditLog.create({
      data: {
        userId: req.user.id,
        action: "RELEASE_INVENTORY",
        entityType: "INVENTORY_RELEASE",
        entityId: createdRelease.id,
        details: {
          saleId: sale.id,
          releaseNumber: createdRelease.releaseNumber,
          completedSale: isCompleted,
        },
      },
    });

    return transaction.inventoryRelease.findUnique({
      where: { id: createdRelease.id },
      include: {
        releasedBy: {
          select: { id: true, fullName: true, username: true },
        },
        sale: {
          select: { id: true, saleNumber: true, status: true, completedAt: true },
        },
        items: {
          include: {
            saleItem: {
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
        },
      },
    });
  });

  return res.status(201).json({
    success: true,
    message:
      release.sale.status === "COMPLETED"
        ? "Inventory released and sale completed"
        : "Partial inventory release recorded",
    data: { release },
  });
}

async function listReleases(req, res) {
  const releases = await prisma.inventoryRelease.findMany({
    take: 100,
    include: {
      releasedBy: { select: { id: true, fullName: true, username: true } },
      sale: { select: { id: true, saleNumber: true, status: true } },
      items: {
        include: {
          saleItem: {
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
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return res.json({ success: true, data: { releases } });
}

module.exports = {
  listPendingReleases,
  createRelease,
  listReleases,
};
