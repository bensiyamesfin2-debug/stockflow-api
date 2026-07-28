const { randomUUID } = require("crypto");
const prisma = require("../config/prisma");
const HttpError = require("../utils/HttpError");
const { moneyToCents, centsToMoney } = require("../utils/money");
const { runSerializableTransaction } = require("../utils/transaction");
const { normalizeClientRequestId } = require("../utils/clientRequestId");
const { sellableUnitPriceCents } = require("../utils/salePricing");
const {
  calculateCustomOrder,
  normalizeCustomMeasurement,
} = require("../utils/customOrder");

const PAYMENT_METHODS = new Set([
  "CASH",
  "BANK_TRANSFER",
  "MOBILE_MONEY",
  "CARD",
]);
const SALE_STATUSES = new Set([
  "PENDING_RELEASE",
  "PARTIALLY_RELEASED",
  "COMPLETED",
  "CANCELLED",
]);

const saleInclude = {
  cashier: {
    select: { id: true, fullName: true, username: true },
  },
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
  payments: true,
  releases: {
    select: {
      id: true,
      releaseNumber: true,
      createdAt: true,
      releasedBy: { select: { id: true, fullName: true, username: true } },
    },
  },
};

function makeSaleNumber() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `SALE-${date}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

function serializeSale(sale) {
  const { clientRequestId, ...publicSale } = sale;
  return {
    ...publicSale,
    items: sale.items.map((item) => ({
      ...item,
      remainingQuantity: item.quantity - item.releasedQuantity,
    })),
  };
}

function validateSaleRequest(body) {
  const errors = [];
  const customerName = String(body.customerName || "").trim() || null;
  const rawItems = body.items;
  const rawPayments = body.payments;
  const items = [];
  const payments = [];
  const productIds = new Set();
  const clientRequestId = normalizeClientRequestId(body.clientRequestId);

  if (clientRequestId === undefined) {
    errors.push("The sale synchronization ID is invalid");
  }

  if (customerName && customerName.length > 150) {
    errors.push("Customer name cannot exceed 150 characters");
  }

  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    errors.push("At least one sale item is required");
  } else if (rawItems.length > 100) {
    errors.push("A sale cannot contain more than 100 items");
  }

  if (Array.isArray(rawItems)) {
    rawItems.forEach((rawItem, index) => {
      const productId = Number(rawItem?.productId);
      const quantity = Number(rawItem?.quantity);
      const customMeasurement = normalizeCustomMeasurement(
        rawItem?.customMeasurement,
        index + 1,
        errors
      );

      if (!Number.isInteger(productId) || productId <= 0) {
        errors.push(`Sale item ${index + 1} has an invalid product ID`);
      }

      if (!Number.isInteger(quantity) || quantity <= 0) {
        errors.push(`Sale item ${index + 1} quantity must be a positive whole number`);
      }

      if (Number.isInteger(productId) && productIds.has(productId)) {
        errors.push(`Product ${productId} appears more than once in the sale`);
      }

      productIds.add(productId);
      items.push({ productId, quantity, customMeasurement });
    });
  }

  if (!Array.isArray(rawPayments)) {
    errors.push("Payments must be provided as a list");
  } else if (rawPayments.length > 10) {
    errors.push("A sale cannot contain more than 10 payment entries");
  }

  if (Array.isArray(rawPayments)) {
    rawPayments.forEach((rawPayment, index) => {
      const paymentMethod = String(rawPayment?.paymentMethod || "")
        .trim()
        .toUpperCase();
      const amountCents = moneyToCents(rawPayment?.amount);
      const bankName = String(rawPayment?.bankName || "").trim() || null;
      const transactionReference =
        String(rawPayment?.transactionReference || "").trim() || null;

      if (!PAYMENT_METHODS.has(paymentMethod)) {
        errors.push(`Payment ${index + 1} has an invalid payment method`);
      }

      if (amountCents === null || amountCents <= 0n) {
        errors.push(`Payment ${index + 1} amount must be greater than zero`);
      }

      if (bankName && bankName.length > 150) {
        errors.push(`Payment ${index + 1} bank name cannot exceed 150 characters`);
      }

      if (transactionReference && transactionReference.length > 150) {
        errors.push(
          `Payment ${index + 1} transaction reference cannot exceed 150 characters`
        );
      }

      if (paymentMethod === "BANK_TRANSFER" && !bankName) {
        errors.push(`Payment ${index + 1} requires a bank name`);
      }

      if (
        ["BANK_TRANSFER", "MOBILE_MONEY", "CARD"].includes(paymentMethod) &&
        !transactionReference
      ) {
        errors.push(`Payment ${index + 1} requires a transaction reference`);
      }

      payments.push({
        paymentMethod,
        amountCents,
        bankName: paymentMethod === "CASH" ? null : bankName,
        transactionReference:
          paymentMethod === "CASH" ? null : transactionReference,
      });
    });
  }

  return {
    data: { customerName, items, payments, clientRequestId: clientRequestId || null },
    errors,
  };
}

async function createSale(req, res) {
  const { data, errors } = validateSaleRequest(req.body);

  if (errors.length > 0) {
    return res.status(400).json({ success: false, message: errors[0], errors });
  }

  let result;

  try {
    result = await runSerializableTransaction(async (transaction) => {
      if (data.clientRequestId) {
        const existingSale = await transaction.sale.findUnique({
          where: { clientRequestId: data.clientRequestId },
          include: saleInclude,
        });

        if (existingSale) {
          if (existingSale.cashierId !== req.user.id) {
            throw new HttpError(409, "This sale synchronization ID is already in use");
          }

          return { sale: existingSale, repeated: true };
        }
      }

    const products = await transaction.product.findMany({
      where: { id: { in: data.items.map((item) => item.productId) } },
      include: { inventory: true },
    });

    if (products.length !== data.items.length) {
      throw new HttpError(400, "One or more products do not exist");
    }

    const productsById = new Map(products.map((product) => [product.id, product]));
    let totalCents = 0n;

    for (const item of data.items) {
      const product = productsById.get(item.productId);

      if (!product.isActive) {
        throw new HttpError(400, `${product.name} is inactive and cannot be sold`);
      }

      const inventory = product.inventory;
      if (item.customMeasurement) {
        const calculation = calculateCustomOrder(product, item.customMeasurement);
        if (item.quantity !== calculation.quantity) {
          throw new HttpError(
            409,
            `The custom order requires ${calculation.quantity} stock unit(s)`
          );
        }
        item.piecesPerStockUnit = calculation.piecesPerStockUnit;
      }
      const availableQuantity = inventory
        ? inventory.quantity - inventory.reservedQuantity
        : 0;

      if (availableQuantity < item.quantity) {
        throw new HttpError(
          409,
          `Only ${availableQuantity} unit(s) of ${product.name} are available`
        );
      }

      totalCents += sellableUnitPriceCents(product) * BigInt(item.quantity);
    }

    const paymentTotalCents = data.payments.reduce(
      (total, payment) => total + (payment.amountCents || 0n),
      0n
    );

    if (totalCents > 0n && data.payments.length === 0) {
      throw new HttpError(400, "At least one payment is required");
    }

    if (paymentTotalCents !== totalCents) {
      throw new HttpError(
        400,
        `Payment total must equal the sale total of ${centsToMoney(totalCents)}`
      );
    }

    const createdSale = await transaction.sale.create({
      data: {
        saleNumber: makeSaleNumber(),
        clientRequestId: data.clientRequestId,
        cashierId: req.user.id,
        customerName: data.customerName,
        totalAmount: centsToMoney(totalCents),
      },
    });

    for (const item of data.items) {
      const product = productsById.get(item.productId);

      await transaction.saleItem.create({
        data: {
          saleId: createdSale.id,
          productId: product.id,
          quantity: item.quantity,
          unitPrice: product.sellingPrice,
          costPriceAtSale: product.costPrice,
          customLength: item.customMeasurement?.length || null,
          customWidth: item.customMeasurement?.width || null,
          customThickness: item.customMeasurement?.thickness || null,
          requestedPieces: item.customMeasurement?.pieces || null,
          piecesPerStockUnit: item.piecesPerStockUnit || null,
        },
      });

      await transaction.inventory.update({
        where: { productId: product.id },
        data: { reservedQuantity: { increment: item.quantity } },
      });
    }

    for (const payment of data.payments) {
      await transaction.payment.create({
        data: {
          saleId: createdSale.id,
          paymentMethod: payment.paymentMethod,
          bankName: payment.bankName,
          transactionReference: payment.transactionReference,
          amount: centsToMoney(payment.amountCents),
          recordedById: req.user.id,
        },
      });
    }

    await transaction.auditLog.create({
      data: {
        userId: req.user.id,
        action: "CREATE_SALE",
        entityType: "SALE",
        entityId: createdSale.id,
        details: {
          saleNumber: createdSale.saleNumber,
          itemCount: data.items.length,
          paymentMethods: data.payments.map((payment) => payment.paymentMethod),
        },
      },
    });

    const sale = await transaction.sale.findUnique({
      where: { id: createdSale.id },
      include: saleInclude,
    });

      return { sale, repeated: false };
    });
  } catch (error) {
    if (data.clientRequestId && error.code === "P2002") {
      const existingSale = await prisma.sale.findUnique({
        where: { clientRequestId: data.clientRequestId },
        include: saleInclude,
      });

      if (existingSale && existingSale.cashierId === req.user.id) {
        result = { sale: existingSale, repeated: true };
      } else {
        throw error;
      }
    } else {
      throw error;
    }
  }

  return res.status(result.repeated ? 200 : 201).json({
    success: true,
    message: result.repeated
      ? "Sale was already synchronized"
      : "Sale recorded and reserved for inventory release",
    data: { sale: serializeSale(result.sale), repeated: result.repeated },
  });
}

async function updateSale(req, res) {
  const saleId = Number(req.params.id);

  if (!Number.isInteger(saleId) || saleId <= 0) {
    return res.status(400).json({ success: false, message: "Invalid sale ID" });
  }

  const { data, errors } = validateSaleRequest({
    ...req.body,
    clientRequestId: null,
  });

  if (errors.length > 0) {
    return res.status(400).json({ success: false, message: errors[0], errors });
  }

  const sale = await runSerializableTransaction(async (transaction) => {
    const existingSale = await transaction.sale.findUnique({
      where: { id: saleId },
      include: { items: true },
    });

    if (!existingSale) {
      throw new HttpError(404, "Sale not found");
    }

    if (
      req.user.role === "CASHIER" &&
      existingSale.cashierId !== req.user.id
    ) {
      throw new HttpError(403, "You can only edit your own orders");
    }

    if (
      existingSale.status !== "PENDING_RELEASE" ||
      existingSale.items.some((item) => item.releasedQuantity > 0)
    ) {
      throw new HttpError(
        409,
        "An order can only be edited before inventory releases any items"
      );
    }

    const products = await transaction.product.findMany({
      where: { id: { in: data.items.map((item) => item.productId) } },
      include: { inventory: true },
    });

    if (products.length !== data.items.length) {
      throw new HttpError(400, "One or more products do not exist");
    }

    const productsById = new Map(
      products.map((product) => [product.id, product])
    );
    const currentQuantityByProduct = new Map(
      existingSale.items.map((item) => [item.productId, item.quantity])
    );
    let totalCents = 0n;

    for (const item of data.items) {
      const product = productsById.get(item.productId);

      if (!product.isActive) {
        throw new HttpError(
          400,
          `${product.name} is inactive and cannot be sold`
        );
      }

      const inventory = product.inventory;
      if (item.customMeasurement) {
        const calculation = calculateCustomOrder(product, item.customMeasurement);
        if (item.quantity !== calculation.quantity) {
          throw new HttpError(
            409,
            `The custom order requires ${calculation.quantity} stock unit(s)`
          );
        }
        item.piecesPerStockUnit = calculation.piecesPerStockUnit;
      }
      const availableQuantity = inventory
        ? inventory.quantity -
          inventory.reservedQuantity +
          (currentQuantityByProduct.get(product.id) || 0)
        : 0;

      if (availableQuantity < item.quantity) {
        throw new HttpError(
          409,
          `Only ${availableQuantity} unit(s) of ${product.name} are available`
        );
      }

      totalCents += sellableUnitPriceCents(product) * BigInt(item.quantity);
    }

    const paymentTotalCents = data.payments.reduce(
      (total, payment) => total + (payment.amountCents || 0n),
      0n
    );

    if (totalCents > 0n && data.payments.length === 0) {
      throw new HttpError(400, "At least one payment is required");
    }

    if (paymentTotalCents !== totalCents) {
      throw new HttpError(
        400,
        `Payment total must equal the order total of ${centsToMoney(totalCents)}`
      );
    }

    for (const item of existingSale.items) {
      await transaction.inventory.update({
        where: { productId: item.productId },
        data: { reservedQuantity: { decrement: item.quantity } },
      });
    }

    await transaction.payment.deleteMany({ where: { saleId } });
    await transaction.saleItem.deleteMany({ where: { saleId } });

    for (const item of data.items) {
      const product = productsById.get(item.productId);

      await transaction.saleItem.create({
        data: {
          saleId,
          productId: product.id,
          quantity: item.quantity,
          unitPrice: product.sellingPrice,
          costPriceAtSale: product.costPrice,
          customLength: item.customMeasurement?.length || null,
          customWidth: item.customMeasurement?.width || null,
          customThickness: item.customMeasurement?.thickness || null,
          requestedPieces: item.customMeasurement?.pieces || null,
          piecesPerStockUnit: item.piecesPerStockUnit || null,
        },
      });

      await transaction.inventory.update({
        where: { productId: product.id },
        data: { reservedQuantity: { increment: item.quantity } },
      });
    }

    for (const payment of data.payments) {
      await transaction.payment.create({
        data: {
          saleId,
          paymentMethod: payment.paymentMethod,
          bankName: payment.bankName,
          transactionReference: payment.transactionReference,
          amount: centsToMoney(payment.amountCents),
          recordedById: req.user.id,
        },
      });
    }

    await transaction.sale.update({
      where: { id: saleId },
      data: {
        customerName: data.customerName,
        totalAmount: centsToMoney(totalCents),
      },
    });

    await transaction.auditLog.create({
      data: {
        userId: req.user.id,
        action: "UPDATE_SALE",
        entityType: "SALE",
        entityId: saleId,
        details: {
          saleNumber: existingSale.saleNumber,
          itemCount: data.items.length,
          paymentMethods: data.payments.map(
            (payment) => payment.paymentMethod
          ),
        },
      },
    });

    return transaction.sale.findUnique({
      where: { id: saleId },
      include: saleInclude,
    });
  });

  return res.json({
    success: true,
    message: "Order updated and inventory reservations recalculated",
    data: { sale: serializeSale(sale) },
  });
}

async function listSales(req, res) {
  const status = String(req.query.status || "").trim().toUpperCase();
  const where = {};

  if (req.user.role === "CASHIER") {
    where.cashierId = req.user.id;
  }

  if (status) {
    if (!SALE_STATUSES.has(status)) {
      return res.status(400).json({ success: false, message: "Invalid sale status" });
    }
    where.status = status;
  }

  const sales = await prisma.sale.findMany({
    where,
    take: 100,
    include: saleInclude,
    orderBy: { createdAt: "desc" },
  });

  return res.json({
    success: true,
    data: { sales: sales.map(serializeSale) },
  });
}

async function getSale(req, res) {
  const saleId = Number(req.params.id);

  if (!Number.isInteger(saleId) || saleId <= 0) {
    return res.status(400).json({ success: false, message: "Invalid sale ID" });
  }

  const sale = await prisma.sale.findUnique({
    where: { id: saleId },
    include: saleInclude,
  });

  if (!sale) {
    return res.status(404).json({ success: false, message: "Sale not found" });
  }

  if (req.user.role === "CASHIER" && sale.cashierId !== req.user.id) {
    return res.status(403).json({
      success: false,
      message: "You do not have permission to view this sale",
    });
  }

  return res.json({ success: true, data: { sale: serializeSale(sale) } });
}

async function cancelSale(req, res) {
  const saleId = Number(req.params.id);
  const reason = String(req.body.reason || "").trim();

  if (!Number.isInteger(saleId) || saleId <= 0) {
    return res.status(400).json({ success: false, message: "Invalid sale ID" });
  }

  if (reason.length < 3 || reason.length > 500) {
    return res.status(400).json({
      success: false,
      message: "Cancellation reason must be between 3 and 500 characters",
    });
  }

  const sale = await runSerializableTransaction(async (transaction) => {
    const existingSale = await transaction.sale.findUnique({
      where: { id: saleId },
      include: { items: true },
    });

    if (!existingSale) {
      throw new HttpError(404, "Sale not found");
    }

    if (
      req.user.role === "CASHIER" &&
      existingSale.cashierId !== req.user.id
    ) {
      throw new HttpError(403, "You can only cancel your own sales");
    }

    if (existingSale.status === "CANCELLED") {
      throw new HttpError(409, "Sale is already cancelled");
    }

    if (
      existingSale.status === "COMPLETED" ||
      existingSale.items.some((item) => item.releasedQuantity > 0)
    ) {
      throw new HttpError(
        409,
        "A sale cannot be cancelled after inventory has released any items"
      );
    }

    for (const item of existingSale.items) {
      await transaction.inventory.update({
        where: { productId: item.productId },
        data: { reservedQuantity: { decrement: item.quantity } },
      });
    }

    await transaction.payment.updateMany({
      where: { saleId },
      data: { status: "VOIDED" },
    });

    await transaction.sale.update({
      where: { id: saleId },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancellationReason: reason,
      },
    });

    await transaction.auditLog.create({
      data: {
        userId: req.user.id,
        action: "CANCEL_SALE",
        entityType: "SALE",
        entityId: saleId,
        details: { reason },
      },
    });

    return transaction.sale.findUnique({
      where: { id: saleId },
      include: saleInclude,
    });
  });

  return res.json({
    success: true,
    message: "Sale cancelled and reserved stock restored",
    data: { sale: serializeSale(sale) },
  });
}

module.exports = {
  createSale,
  updateSale,
  listSales,
  getSale,
  cancelSale,
};
