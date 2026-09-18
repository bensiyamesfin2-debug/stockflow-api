const { randomUUID, createHash } = require("crypto");
const ExcelJS = require("exceljs");
const prisma = require("../config/prisma");
const HttpError = require("../utils/HttpError");
const { moneyToCents, centsToMoney } = require("../utils/money");
const { runSerializableTransaction } = require("../utils/transaction");
const { normalizeClientRequestId } = require("../utils/clientRequestId");
const { resolveCustomerPriceList, saleUnitPriceCents } = require("../utils/priceLists");
const { calculateDiscountCents } = require("../utils/discounts");
const { buildSaleNotification } = require("../utils/saleNotification");
const {
  sendNewSalePushNotification,
} = require("../utils/pushNotifications");
const { deliverWhatsAppText, saleWhatsAppMessage } = require("../utils/whatsapp");
const {
  planCustomCuts,
  normalizeCustomMeasurement,
  calculateCustomOrder,
} = require("../utils/customOrder");
const { parseSalesWorkbook, productLabel } = require("../utils/salesWorkbook");

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
  "PARTIALLY_RETURNED",
  "RETURNED",
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
  returns: {
    include: { items: true },
    orderBy: { createdAt: "desc" },
  },
  customer: {
    select: { id: true, name: true, phone: true, email: true },
  },
  discount: {
    select: { id: true, code: true, name: true, type: true, value: true },
  },
  shift: {
    select: { id: true, status: true, openedAt: true, closedAt: true },
  },
  priceList: { select: { id: true, name: true } },
  releases: {
    select: {
      id: true,
      releaseNumber: true,
      createdAt: true,
      releasedBy: { select: { id: true, fullName: true, username: true } },
    },
  },
};

function makeSaleNumber(saleDate = new Date()) {
  const date = saleDate.toISOString().slice(0, 10).replaceAll("-", "");
  return `SALE-${date}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

function makeReturnNumber() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `RET-${date}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

function serializeSale(sale) {
  const { clientRequestId, ...publicSale } = sale;
  const completedCents = (sale.payments || []).filter((payment) => payment.status === "COMPLETED").reduce((total, payment) => total + moneyToCents(payment.amount.toFixed(2)), 0n);
  const refundedCents = (sale.payments || []).filter((payment) => payment.status === "REFUNDED").reduce((total, payment) => total + moneyToCents(payment.amount.toFixed(2)), 0n);
  const returnedCents = (sale.returns || []).reduce((total, record) => total + moneyToCents(record.returnValue.toFixed(2)), 0n);
  const payableCents = [moneyToCents(sale.totalAmount.toFixed(2)) - returnedCents, 0n].reduce((maximum, value) => value > maximum ? value : maximum, 0n);
  const netPaidCents = completedCents > refundedCents ? completedCents - refundedCents : 0n;
  const paymentStatus = sale.status === "CANCELLED" ? "VOIDED" : sale.status === "RETURNED" && payableCents === 0n ? "REFUNDED" : netPaidCents <= 0n ? "UNPAID" : netPaidCents < payableCents ? "PARTIAL" : "PAID";
  return {
    ...publicSale,
    paymentStatus,
    returnedAmount: centsToMoney(returnedCents),
    netAmount: centsToMoney(payableCents),
    items: sale.items.map((item) => ({
      ...item,
      remainingQuantity: item.quantity - item.releasedQuantity,
      returnableQuantity: item.releasedQuantity - item.returnedQuantity,
    })),
  };
}

function parseSaleDate(value, endOfDay = false) {
  if (!value) return undefined;
  const raw = String(value).trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T${endOfDay ? "23:59:59.999" : "00:00:00"}`)
    : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function validateSaleRequest(body) {
  const errors = [];
  const customerName = String(body.customerName || "").trim() || null;
  const rawItems = body.items;
  const rawPayments = body.payments;
  const items = [];
  const payments = [];
  const clientRequestId = normalizeClientRequestId(body.clientRequestId);
  const customerId =
    body.customerId === undefined || body.customerId === null || body.customerId === ""
      ? null
      : Number(body.customerId);
  const discountId =
    body.discountId === undefined || body.discountId === null || body.discountId === ""
      ? null
      : Number(body.discountId);
  const discountCode = String(body.discountCode || "").trim().toUpperCase() || null;
  const allowCredit = Boolean(body.allowCredit);
  const creditDueAt = body.creditDueAt ? new Date(body.creditDueAt) : null;

  if (clientRequestId === undefined) {
    errors.push("The sale synchronization ID is invalid");
  }

  if (customerName && customerName.length > 150) {
    errors.push("Customer name cannot exceed 150 characters");
  }
  if (customerId !== null && (!Number.isInteger(customerId) || customerId <= 0)) {
    errors.push("Customer ID is invalid");
  }
  if (discountId !== null && (!Number.isInteger(discountId) || discountId <= 0)) {
    errors.push("Discount ID is invalid");
  }
  if (discountId !== null && discountCode) {
    errors.push("Provide either a discount ID or discount code, not both");
  }
  if (body.creditDueAt && (!creditDueAt || Number.isNaN(creditDueAt.getTime()))) {
    errors.push("Credit due date is invalid");
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

      if (!Number.isInteger(quantity) || (customMeasurement ? quantity < 0 : quantity <= 0)) {
        errors.push(`Sale item ${index + 1} quantity must be ${customMeasurement ? "zero or a positive" : "a positive"} whole number`);
      }

      let overrideUnitPriceCents = null;
      let priceOverrideReason = null;
      if (rawItem?.unitPrice !== undefined && rawItem?.unitPrice !== null && rawItem?.unitPrice !== "") {
        overrideUnitPriceCents = moneyToCents(rawItem.unitPrice);
        if (overrideUnitPriceCents === null || overrideUnitPriceCents <= 0n) {
          errors.push(`Sale item ${index + 1} override price is invalid`);
        }
        priceOverrideReason = String(rawItem?.priceOverrideReason || "").trim() || null;
        if (!priceOverrideReason) {
          errors.push(`Sale item ${index + 1} requires a reason for the price override`);
        } else if (priceOverrideReason.length > 300) {
          errors.push(`Sale item ${index + 1} override reason cannot exceed 300 characters`);
        }
      }

      items.push({ productId, quantity, customMeasurement, overrideUnitPriceCents, priceOverrideReason });
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
      const recipientAccount = String(rawPayment?.recipientAccount || "").trim() || null;
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

      if (recipientAccount && recipientAccount.length > 150) {
        errors.push(`Payment ${index + 1} recipient account cannot exceed 150 characters`);
      }

      if (transactionReference && transactionReference.length > 150) {
        errors.push(
          `Payment ${index + 1} transaction reference cannot exceed 150 characters`
        );
      }

      if (paymentMethod === "BANK_TRANSFER" && !bankName) {
        errors.push(`Payment ${index + 1} requires a bank name`);
      }

      if (["BANK_TRANSFER", "MOBILE_MONEY"].includes(paymentMethod) && !recipientAccount) {
        errors.push(`Payment ${index + 1} requires a recipient account`);
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
        recipientAccount: paymentMethod === "CASH" ? null : recipientAccount,
        transactionReference:
          paymentMethod === "CASH" ? null : transactionReference,
      });
    });
  }

  return {
    data: {
      customerName,
      customerId,
      discountId,
      discountCode,
      allowCredit,
      creditDueAt,
      items,
      payments,
      clientRequestId: clientRequestId || null,
    },
    errors,
  };
}

function sumQuantityByProduct(items) {
  return items.reduce((quantities, item) => {
    quantities.set(
      item.productId,
      (quantities.get(item.productId) || 0) + item.quantity
    );
    return quantities;
  }, new Map());
}

function applySharedCustomCutPlans(items, productsById) {
  const grouped = new Map();
  items.forEach((item, index) => {
    if (!item.customMeasurement) return;
    const entries = grouped.get(item.productId) || [];
    entries.push({ item, index });
    grouped.set(item.productId, entries);
  });

  for (const [productId, entries] of grouped) {
    const product = productsById.get(productId);
    const plan = planCustomCuts(product, entries.map((entry) => entry.item.customMeasurement));
    entries.forEach((entry, index) => {
      entry.item.quantity = plan.allocations[index];
      entry.item.piecesPerStockUnit = plan.piecesPerStockUnit[index];
    });
  }
}

function ensureRequestedStockIsAvailable(
  productsById,
  requestedQuantityByProduct,
  existingQuantityByProduct = new Map()
) {
  for (const [productId, requestedQuantity] of requestedQuantityByProduct) {
    const product = productsById.get(productId);
    const inventory = product?.inventory;
    const availableQuantity = inventory
      ? inventory.quantity - inventory.reservedQuantity +
        (existingQuantityByProduct.get(productId) || 0)
      : 0;

    if (availableQuantity < requestedQuantity) {
      throw new HttpError(
        409,
        `Only ${availableQuantity} unit(s) of ${product.name} are available`
      );
    }
  }
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

    const productIds = [...new Set(data.items.map((item) => item.productId))];
    const products = await transaction.product.findMany({
      where: { id: { in: productIds } },
      include: { inventory: true },
    });

    if (products.length !== productIds.length) {
      throw new HttpError(400, "One or more products do not exist");
    }

    const productsById = new Map(products.map((product) => [product.id, product]));
    applySharedCustomCutPlans(data.items, productsById);
    let customer = null;
    if (data.customerId !== null) {
      customer = await transaction.customer.findUnique({ where: { id: data.customerId } });
      if (!customer || !customer.isActive) {
        throw new HttpError(400, "Customer does not exist or is inactive");
      }
    }
    const { priceList, pricesByProduct } = await resolveCustomerPriceList(transaction, customer);
    let subtotalCents = 0n;
    const requestedQuantityByProduct = new Map();

    for (const item of data.items) {
      const product = productsById.get(item.productId);

      if (!product.isActive) {
        throw new HttpError(400, `${product.name} is inactive and cannot be sold`);
      }

      requestedQuantityByProduct.set(
        product.id,
        (requestedQuantityByProduct.get(product.id) || 0) + item.quantity
      );
      item.unitPriceCents = item.overrideUnitPriceCents ?? saleUnitPriceCents(product, pricesByProduct);
      subtotalCents += item.unitPriceCents * BigInt(item.quantity);
    }

    ensureRequestedStockIsAvailable(productsById, requestedQuantityByProduct);

    let discount = null;
    if (data.discountId !== null || data.discountCode) {
      discount = await transaction.discount.findUnique({
        where: data.discountId !== null
          ? { id: data.discountId }
          : { code: data.discountCode },
      });
      if (!discount) throw new HttpError(400, "Discount does not exist");
    }
    const discountCents = discount
      ? calculateDiscountCents(discount, subtotalCents)
      : 0n;
    const totalCents = subtotalCents - discountCents;

    const paymentTotalCents = data.payments.reduce(
      (total, payment) => total + (payment.amountCents || 0n),
      0n
    );

    if (totalCents > 0n && data.payments.length === 0 && !data.allowCredit) {
      throw new HttpError(400, "At least one payment is required");
    }

    if (paymentTotalCents > totalCents) {
      throw new HttpError(
        400,
        `Payment total cannot exceed the sale total of ${centsToMoney(totalCents)}`
      );
    }
    const creditBalanceCents = totalCents - paymentTotalCents;
    if (creditBalanceCents > 0n && (!data.allowCredit || !customer || !data.creditDueAt)) {
      throw new HttpError(400, "A saved customer and due date are required when part of a sale is on credit");
    }
    if (!data.allowCredit && paymentTotalCents !== totalCents) {
      throw new HttpError(400, `Payment total must equal the sale total of ${centsToMoney(totalCents)}`);
    }

    const activeShift = await transaction.shift.findFirst({
      where: { userId: req.user.id, status: "OPEN" },
      orderBy: { openedAt: "desc" },
      select: { id: true },
    });

    const createdSale = await transaction.sale.create({
      data: {
        saleNumber: makeSaleNumber(),
        clientRequestId: data.clientRequestId,
        cashierId: req.user.id,
        customerId: customer?.id || null,
        customerName: customer?.name || data.customerName,
        priceListId: priceList?.id || null,
        discountId: discount?.id || null,
        discountAmount: centsToMoney(discountCents),
        shiftId: activeShift?.id || null,
        totalAmount: centsToMoney(totalCents),
        creditBalance: centsToMoney(creditBalanceCents),
        creditDueAt: creditBalanceCents > 0n ? data.creditDueAt : null,
      },
    });

    if (discount) {
      await transaction.discount.update({
        where: { id: discount.id },
        data: { usageCount: { increment: 1 } },
      });
    }

    for (const item of data.items) {
      const product = productsById.get(item.productId);

      await transaction.saleItem.create({
        data: {
          saleId: createdSale.id,
          productId: product.id,
          quantity: item.quantity,
          unitPrice: centsToMoney(item.unitPriceCents),
          priceOverrideReason: item.priceOverrideReason,
          costPriceAtSale: product.costPrice,
          customLength: item.customMeasurement?.length || null,
          customWidth: item.customMeasurement?.width || null,
          customThickness: item.customMeasurement?.thickness || null,
          cutLength: item.customMeasurement?.cutLength || null,
          cutWidth: item.customMeasurement?.cutWidth || null,
          cutThickness: item.customMeasurement?.cutThickness || null,
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
          recipientAccount: payment.recipientAccount,
          transactionReference: payment.transactionReference,
          amount: centsToMoney(payment.amountCents),
          recordedById: req.user.id,
        },
      });
    }

    const inventoryStaff = await transaction.user.findMany({
      where: { role: "INVENTORY_STAFF", isActive: true },
      select: { id: true },
    });
    const notification = buildSaleNotification({
      saleNumber: createdSale.saleNumber,
      customerName: createdSale.customerName,
      items: data.items,
    });

    if (inventoryStaff.length) {
      await transaction.notification.createMany({
        data: inventoryStaff.map((staff) => ({
          userId: staff.id,
          saleId: createdSale.id,
          ...notification,
        })),
      });
    }

    const priceOverrides = data.items
      .filter((item) => item.priceOverrideReason)
      .map((item) => ({ productId: item.productId, overridePrice: centsToMoney(item.unitPriceCents), reason: item.priceOverrideReason }));

    await transaction.auditLog.create({
      data: {
        userId: req.user.id,
        action: priceOverrides.length ? "CREATE_SALE_WITH_PRICE_OVERRIDE" : "CREATE_SALE",
        entityType: "SALE",
        entityId: createdSale.id,
        details: {
          saleNumber: createdSale.saleNumber,
          itemCount: data.items.length,
          notifiedInventoryStaff: inventoryStaff.length,
          paymentMethods: data.payments.map((payment) => payment.paymentMethod),
          customerId: customer?.id || null,
          priceListId: priceList?.id || null,
          discountId: discount?.id || null,
          discountAmount: centsToMoney(discountCents),
          shiftId: activeShift?.id || null,
          creditBalance: centsToMoney(creditBalanceCents),
          creditDueAt: creditBalanceCents > 0n ? data.creditDueAt : null,
          ...(priceOverrides.length ? { priceOverrides } : {}),
        },
      },
    });

    const sale = await transaction.sale.findUnique({
      where: { id: createdSale.id },
      include: saleInclude,
    });

      return { sale, repeated: false, notification };
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

  if (!result.repeated) {
    void sendNewSalePushNotification({
      saleId: result.sale.id,
      title: result.notification.title,
      message: result.notification.message,
    }).catch((error) => {
      console.error("Unable to prepare sale push notifications:", error.message);
    });
    void deliverWhatsAppText({
      phone: result.sale.customer?.phone,
      message: saleWhatsAppMessage(result.sale),
    });
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

    const productIds = [...new Set(data.items.map((item) => item.productId))];
    const products = await transaction.product.findMany({
      where: { id: { in: productIds } },
      include: { inventory: true },
    });

    if (products.length !== productIds.length) {
      throw new HttpError(400, "One or more products do not exist");
    }

    const productsById = new Map(
      products.map((product) => [product.id, product])
    );
    applySharedCustomCutPlans(data.items, productsById);
    let customer = null;
    if (data.customerId !== null) {
      customer = await transaction.customer.findUnique({ where: { id: data.customerId } });
      if (!customer || !customer.isActive) {
        throw new HttpError(400, "Customer does not exist or is inactive");
      }
    }
    const { priceList, pricesByProduct } = await resolveCustomerPriceList(transaction, customer);
    const currentQuantityByProduct = sumQuantityByProduct(existingSale.items);
    let subtotalCents = 0n;
    const requestedQuantityByProduct = new Map();

    for (const item of data.items) {
      const product = productsById.get(item.productId);

      if (!product.isActive) {
        throw new HttpError(
          400,
          `${product.name} is inactive and cannot be sold`
        );
      }

      requestedQuantityByProduct.set(
        product.id,
        (requestedQuantityByProduct.get(product.id) || 0) + item.quantity
      );
      item.unitPriceCents = item.overrideUnitPriceCents ?? saleUnitPriceCents(product, pricesByProduct);
      subtotalCents += item.unitPriceCents * BigInt(item.quantity);
    }

    ensureRequestedStockIsAvailable(
      productsById,
      requestedQuantityByProduct,
      currentQuantityByProduct
    );

    let discount = null;
    if (data.discountId !== null || data.discountCode) {
      discount = await transaction.discount.findUnique({
        where: data.discountId !== null
          ? { id: data.discountId }
          : { code: data.discountCode },
      });
      if (!discount) throw new HttpError(400, "Discount does not exist");
    }
    const discountCents = discount
      ? calculateDiscountCents(
          discount.id === existingSale.discountId
            ? { ...discount, usageCount: Math.max(0, discount.usageCount - 1) }
            : discount,
          subtotalCents
        )
      : 0n;
    const totalCents = subtotalCents - discountCents;

    const paymentTotalCents = data.payments.reduce(
      (total, payment) => total + (payment.amountCents || 0n),
      0n
    );

    if (totalCents > 0n && data.payments.length === 0 && !data.allowCredit) {
      throw new HttpError(400, "At least one payment is required");
    }

    if (paymentTotalCents > totalCents) {
      throw new HttpError(
        400,
        `Payment total cannot exceed the order total of ${centsToMoney(totalCents)}`
      );
    }
    const creditBalanceCents = totalCents - paymentTotalCents;
    if (creditBalanceCents > 0n && (!data.allowCredit || !customer || !data.creditDueAt)) {
      throw new HttpError(400, "A saved customer and due date are required when part of an order is on credit");
    }
    if (!data.allowCredit && paymentTotalCents !== totalCents) {
      throw new HttpError(400, `Payment total must equal the order total of ${centsToMoney(totalCents)}`);
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
          unitPrice: centsToMoney(item.unitPriceCents),
          priceOverrideReason: item.priceOverrideReason,
          costPriceAtSale: product.costPrice,
          customLength: item.customMeasurement?.length || null,
          customWidth: item.customMeasurement?.width || null,
          customThickness: item.customMeasurement?.thickness || null,
          cutLength: item.customMeasurement?.cutLength || null,
          cutWidth: item.customMeasurement?.cutWidth || null,
          cutThickness: item.customMeasurement?.cutThickness || null,
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
          recipientAccount: payment.recipientAccount,
          transactionReference: payment.transactionReference,
          amount: centsToMoney(payment.amountCents),
          recordedById: req.user.id,
        },
      });
    }

    await transaction.sale.update({
      where: { id: saleId },
      data: {
        customerId: customer?.id || null,
        customerName: customer?.name || data.customerName,
        priceListId: priceList?.id || null,
        discountId: discount?.id || null,
        discountAmount: centsToMoney(discountCents),
        totalAmount: centsToMoney(totalCents),
        creditBalance: centsToMoney(creditBalanceCents),
        creditDueAt: creditBalanceCents > 0n ? data.creditDueAt : null,
      },
    });

    if (existingSale.discountId && existingSale.discountId !== discount?.id) {
      await transaction.discount.update({
        where: { id: existingSale.discountId },
        data: { usageCount: { decrement: 1 } },
      });
    }
    if (discount && discount.id !== existingSale.discountId) {
      await transaction.discount.update({
        where: { id: discount.id },
        data: { usageCount: { increment: 1 } },
      });
    }

    const priceOverrides = data.items
      .filter((item) => item.priceOverrideReason)
      .map((item) => ({ productId: item.productId, overridePrice: centsToMoney(item.unitPriceCents), reason: item.priceOverrideReason }));

    await transaction.auditLog.create({
      data: {
        userId: req.user.id,
        action: priceOverrides.length ? "UPDATE_SALE_WITH_PRICE_OVERRIDE" : "UPDATE_SALE",
        entityType: "SALE",
        entityId: saleId,
        details: {
          saleNumber: existingSale.saleNumber,
          itemCount: data.items.length,
          paymentMethods: data.payments.map(
            (payment) => payment.paymentMethod
          ),
          customerId: customer?.id || null,
          priceListId: priceList?.id || null,
          discountId: discount?.id || null,
          discountAmount: centsToMoney(discountCents),
          creditBalance: centsToMoney(creditBalanceCents),
          creditDueAt: creditBalanceCents > 0n ? data.creditDueAt : null,
          ...(priceOverrides.length ? { priceOverrides } : {}),
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

async function recordCreditPayment(req, res) {
  const saleId = Number(req.params.id);
  const paymentMethod = String(req.body.paymentMethod || "").trim().toUpperCase();
  const amountCents = moneyToCents(req.body.amount);
  const bankName = String(req.body.bankName || "").trim() || null;
  const recipientAccount = String(req.body.recipientAccount || "").trim() || null;
  const transactionReference = String(req.body.transactionReference || "").trim() || null;
  if (!Number.isInteger(saleId) || saleId <= 0 || !PAYMENT_METHODS.has(paymentMethod) || amountCents === null || amountCents <= 0n) {
    return res.status(400).json({ success: false, message: "Enter a valid payment method and amount" });
  }
  if (bankName && bankName.length > 150) return res.status(400).json({ success: false, message: "Bank name cannot exceed 150 characters" });
  if (recipientAccount && recipientAccount.length > 150) return res.status(400).json({ success: false, message: "Recipient account cannot exceed 150 characters" });
  if (transactionReference && transactionReference.length > 150) return res.status(400).json({ success: false, message: "Transaction reference cannot exceed 150 characters" });
  if (paymentMethod === "BANK_TRANSFER" && !bankName) return res.status(400).json({ success: false, message: "Bank transfer requires a bank name" });
  if (["BANK_TRANSFER", "MOBILE_MONEY"].includes(paymentMethod) && !recipientAccount) return res.status(400).json({ success: false, message: "This payment method requires a recipient account" });
  if (["BANK_TRANSFER", "MOBILE_MONEY", "CARD"].includes(paymentMethod) && !transactionReference) return res.status(400).json({ success: false, message: "This payment method requires a transaction reference" });

  const sale = await runSerializableTransaction(async (transaction) => {
    const existing = await transaction.sale.findUnique({ where: { id: saleId } });
    if (!existing) throw new HttpError(404, "Sale not found");
    if (req.user.role === "CASHIER" && existing.cashierId !== req.user.id) throw new HttpError(403, "You can only collect payment for your own order");
    if (existing.status === "CANCELLED") throw new HttpError(409, "Payment cannot be collected for a cancelled sale");
    const remainingCents = moneyToCents(existing.creditBalance.toFixed(2));
    if (remainingCents <= 0n) throw new HttpError(409, "This sale has no outstanding credit balance");
    if (amountCents > remainingCents) throw new HttpError(400, `Payment cannot exceed the outstanding balance of ${centsToMoney(remainingCents)}`);
    await transaction.payment.create({
      data: {
        saleId,
        paymentMethod,
        bankName: paymentMethod === "CASH" ? null : bankName,
        recipientAccount: paymentMethod === "CASH" ? null : recipientAccount,
        transactionReference: paymentMethod === "CASH" ? null : transactionReference,
        amount: centsToMoney(amountCents),
        recordedById: req.user.id,
      },
    });
    const updated = await transaction.sale.update({ where: { id: saleId }, data: { creditBalance: centsToMoney(remainingCents - amountCents) }, include: saleInclude });
    await transaction.auditLog.create({ data: { userId: req.user.id, action: "COLLECT_CREDIT_PAYMENT", entityType: "SALE", entityId: saleId, details: { saleNumber: existing.saleNumber, amount: centsToMoney(amountCents), paymentMethod, bankName, recipientAccount, remainingBalance: centsToMoney(remainingCents - amountCents) } } });
    return updated;
  });
  return res.status(201).json({ success: true, message: "Credit payment recorded", data: { sale: serializeSale(sale) } });
}

async function listSales(req, res) {
  const status = String(req.query.status || "").trim().toUpperCase();
  const where = {};
  const from = parseSaleDate(req.query.from);
  const to = parseSaleDate(req.query.to, true);

  if (from === null || to === null || (from && to && from > to)) {
    return res.status(400).json({ success: false, message: "Invalid sale date range" });
  }

  if (req.user.role === "CASHIER") {
    where.cashierId = req.user.id;
  }

  if (status) {
    if (!SALE_STATUSES.has(status)) {
      return res.status(400).json({ success: false, message: "Invalid sale status" });
    }
    where.status = status;
  }

  if (from || to) {
    where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
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

    if (existingSale.discountId) {
      await transaction.discount.updateMany({
        where: { id: existingSale.discountId, usageCount: { gt: 0 } },
        data: { usageCount: { decrement: 1 } },
      });
    }

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

async function returnSale(req, res) {
  const saleId = Number(req.params.id);
  const reason = String(req.body.reason || "").trim();
  const refundMethod = req.body.refundMethod ? String(req.body.refundMethod).trim().toUpperCase() : null;
  const refundCents = req.body.refundAmount === undefined || req.body.refundAmount === "" ? 0n : moneyToCents(req.body.refundAmount);
  const rawItems = req.body.items;
  if (!Number.isInteger(saleId) || saleId <= 0) throw new HttpError(400, "Invalid sale ID");
  if (reason.length < 3 || reason.length > 1000) throw new HttpError(400, "Return reason must be between 3 and 1,000 characters");
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > 100) throw new HttpError(400, "Choose at least one returned sale item");
  if (refundCents === null || refundCents < 0n) throw new HttpError(400, "Refund amount is invalid");
  if (refundCents > 0n && !PAYMENT_METHODS.has(refundMethod)) throw new HttpError(400, "Choose how the refund was paid");
  const seen = new Set();
  const items = rawItems.map((rawItem, index) => {
    const saleItemId = Number(rawItem?.saleItemId);
    const quantity = Number(rawItem?.quantity);
    const restocked = rawItem?.restocked !== false;
    const locationId = rawItem?.locationId === undefined || rawItem?.locationId === null || rawItem?.locationId === "" ? null : Number(rawItem.locationId);
    if (!Number.isInteger(saleItemId) || saleItemId <= 0 || !Number.isInteger(quantity) || quantity <= 0) throw new HttpError(400, `Return line ${index + 1} is invalid`);
    if (seen.has(saleItemId)) throw new HttpError(400, `Sale item ${saleItemId} appears more than once`);
    if (locationId !== null && (!Number.isInteger(locationId) || locationId <= 0)) throw new HttpError(400, `Return line ${index + 1} has an invalid location`);
    seen.add(saleItemId);
    return { saleItemId, quantity, restocked, locationId };
  });

  const returnedSale = await runSerializableTransaction(async (transaction) => {
    const sale = await transaction.sale.findUnique({ where: { id: saleId }, include: { payments: true, items: { include: { product: { include: { inventory: true } } } } } });
    if (!sale) throw new HttpError(404, "Sale not found");
    if (req.user.role === "CASHIER" && sale.cashierId !== req.user.id) throw new HttpError(403, "You can only return items from your own sale");
    if (!["COMPLETED", "PARTIALLY_RETURNED"].includes(sale.status)) throw new HttpError(409, "Only a fully released sale can be returned");
    const saleItemsById = new Map(sale.items.map((item) => [item.id, item]));
    let returnValueCents = 0n;
    for (const item of items) {
      const saleItem = saleItemsById.get(item.saleItemId);
      if (!saleItem) throw new HttpError(400, "A return item does not belong to this sale");
      const returnable = saleItem.releasedQuantity - saleItem.returnedQuantity;
      if (item.quantity > returnable) throw new HttpError(409, `Only ${returnable} unit(s) of ${saleItem.product.name} can still be returned`);
      if (item.locationId) {
        const location = await transaction.inventoryLocation.findFirst({ where: { id: item.locationId, isActive: true } });
        if (!location) throw new HttpError(400, "A selected return location is unavailable");
      }
      returnValueCents += moneyToCents(saleItem.unitPrice.toFixed(2)) * BigInt(item.quantity);
    }
    const currentCreditCents = moneyToCents(sale.creditBalance.toFixed(2));
    const creditAdjustmentCents = currentCreditCents < returnValueCents ? currentCreditCents : returnValueCents;
    const completedPaymentCents = sale.payments.filter((payment) => payment.status === "COMPLETED").reduce((total, payment) => total + moneyToCents(payment.amount.toFixed(2)), 0n);
    const previousRefundCents = sale.payments.filter((payment) => payment.status === "REFUNDED").reduce((total, payment) => total + moneyToCents(payment.amount.toFixed(2)), 0n);
    const remainingPaidCents = completedPaymentCents > previousRefundCents ? completedPaymentCents - previousRefundCents : 0n;
    const returnRefundableCents = returnValueCents - creditAdjustmentCents;
    const maximumCashRefundCents = remainingPaidCents < returnRefundableCents ? remainingPaidCents : returnRefundableCents;
    if (refundCents > maximumCashRefundCents) throw new HttpError(400, `Refund cannot exceed ${centsToMoney(maximumCashRefundCents)} after credit adjustment`);

    const createdReturn = await transaction.saleReturn.create({ data: { returnNumber: makeReturnNumber(), saleId, processedById: req.user.id, reason, returnValue: centsToMoney(returnValueCents), refundAmount: centsToMoney(refundCents), refundMethod: refundCents > 0n ? refundMethod : null } });
    for (const item of items) {
      const saleItem = saleItemsById.get(item.saleItemId);
      await transaction.saleReturnItem.create({ data: { returnId: createdReturn.id, saleItemId: item.saleItemId, quantity: item.quantity, restocked: item.restocked, locationId: item.restocked ? item.locationId : null } });
      await transaction.saleItem.update({ where: { id: item.saleItemId }, data: { returnedQuantity: { increment: item.quantity } } });
      if (item.restocked) {
        const inventory = await transaction.inventory.update({ where: { productId: saleItem.productId }, data: { quantity: { increment: item.quantity } } });
        if (item.locationId) await transaction.inventoryLocationBalance.upsert({ where: { locationId_productId: { locationId: item.locationId, productId: saleItem.productId } }, create: { locationId: item.locationId, productId: saleItem.productId, quantity: item.quantity }, update: { quantity: { increment: item.quantity } } });
        await transaction.inventoryMovement.create({ data: { productId: saleItem.productId, movementType: "RETURN_IN", quantityChange: item.quantity, balanceAfter: inventory.quantity, referenceType: "SALE_RETURN", referenceId: createdReturn.id, createdById: req.user.id, notes: reason } });
      }
    }
    if (refundCents > 0n) await transaction.payment.create({ data: { saleId, paymentMethod: refundMethod, status: "REFUNDED", amount: centsToMoney(refundCents), recordedById: req.user.id } });
    const allReturned = sale.items.every((saleItem) => saleItem.returnedQuantity + (items.find((item) => item.saleItemId === saleItem.id)?.quantity || 0) === saleItem.releasedQuantity);
    await transaction.sale.update({ where: { id: saleId }, data: { status: allReturned ? "RETURNED" : "PARTIALLY_RETURNED", creditBalance: centsToMoney(currentCreditCents - creditAdjustmentCents) } });
    await transaction.auditLog.create({ data: { userId: req.user.id, action: "RETURN_SALE", entityType: "SALE_RETURN", entityId: createdReturn.id, details: { saleId, returnNumber: createdReturn.returnNumber, returnValue: centsToMoney(returnValueCents), refundAmount: centsToMoney(refundCents), creditAdjustment: centsToMoney(creditAdjustmentCents), items } } });
    return transaction.sale.findUnique({ where: { id: saleId }, include: saleInclude });
  });
  return res.status(201).json({ success: true, message: "Sale return recorded, stock restored where selected, and payment status recalculated", data: { sale: serializeSale(returnedSale) } });
}

async function salesImportPlan(buffer) {
  const products = await prisma.product.findMany({
    where: { isActive: true },
    include: { inventory: true, category: { select: { id: true, name: true } } },
    orderBy: [{ name: "asc" }, { length: "desc" }, { width: "desc" }, { thickness: "desc" }],
  });
  const parsed = await parseSalesWorkbook(buffer, products);
  if (parsed.errors.length) return parsed;

  const requestedByProduct = new Map();
  for (const row of parsed.rows) {
    if (!row.product) {
      parsed.errors.push(`Row ${row.rowNumber}: create this product in the catalogue first, exactly as a live sale would require`);
      continue;
    }
    if (row.customMeasurement) {
      try {
        const plan = calculateCustomOrder(row.product, row.customMeasurement);
        row.stockQuantity = plan.quantity;
        row.piecesPerStockUnit = plan.piecesPerStockUnit;
      } catch (error) {
        parsed.errors.push(`Row ${row.rowNumber}: ${error.message}`);
        continue;
      }
    } else {
      row.stockQuantity = row.quantity;
    }
    const requested = (requestedByProduct.get(row.product.id) || 0) + row.stockQuantity;
    requestedByProduct.set(row.product.id, requested);
    const available = (row.product.inventory?.quantity || 0) - (row.product.inventory?.reservedQuantity || 0);
    if (requested > available) {
      parsed.errors.push(`Row ${row.rowNumber}: only ${Math.max(0, available - requested + row.stockQuantity)} more stock unit(s) of ${productLabel(row.product)} are available for this workbook`);
    }
  }
  return parsed;
}

function publicSalesImportPreview(plan) {
  return {
    rows: plan.rows.map((row) => ({
      rowNumber: row.rowNumber,
      saleDate: row.saleDate.toISOString(),
      productId: row.product?.id || null,
      product: row.product ? productLabel(row.product) : `${row.productSpec.name} · ${row.productSpec.length} × ${row.productSpec.width} × ${row.productSpec.thickness}`,
      productAction: row.product ? "UPDATE" : "CREATE",
      productType: row.productType,
      quantity: row.quantity,
      customerSize: row.customMeasurement ? { length: row.customMeasurement.length, width: row.customMeasurement.width, thickness: row.customMeasurement.thickness } : null,
      stockCutSize: row.customMeasurement?.cutLength ? { length: row.customMeasurement.cutLength, width: row.customMeasurement.cutWidth, thickness: row.customMeasurement.cutThickness } : null,
      amount: centsToMoney(row.amountCents),
      paymentMethod: row.paymentMethod,
      bankName: row.bankName,
      recipientAccount: row.recipientAccount,
      customerName: row.customerName,
      amountReceived: centsToMoney(row.collectedCents),
      outstandingCredit: centsToMoney(row.creditBalanceCents),
    })),
    sales: plan.rows.length,
    units: plan.rows.reduce((total, row) => total + row.quantity, 0),
    amount: centsToMoney(plan.rows.reduce((total, row) => total + row.amountCents, 0n)),
    creditAmount: centsToMoney(plan.rows.reduce((total, row) => total + row.creditBalanceCents, 0n)),
  };
}

function hashWorkbookBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function serializeImportBatchSummary(batch) {
  return { id: batch.id, fileName: batch.fileName, createdAt: batch.createdAt, summary: batch.summary };
}

async function previewSalesImport(req, res) {
  const plan = await salesImportPlan(req.body);
  const duplicateBatch = plan.errors.length ? null : await prisma.salesImportBatch.findUnique({ where: { fileHash: hashWorkbookBuffer(req.body) } });
  return res.status(plan.errors.length ? 400 : 200).json({
    success: plan.errors.length === 0,
    message: plan.errors.length ? "Fix the workbook errors before importing" : "Sales workbook validated and ready to import",
    errors: plan.errors,
    data: { preview: plan.errors.length ? null : { ...publicSalesImportPreview(plan), duplicate: duplicateBatch ? serializeImportBatchSummary(duplicateBatch) : null } },
  });
}

async function importSales(req, res) {
  const plan = await salesImportPlan(req.body);
  if (plan.errors.length) return res.status(400).json({ success: false, message: "Fix the workbook errors before importing", errors: plan.errors });

  const fileHash = hashWorkbookBuffer(req.body);
  const duplicateBatch = await prisma.salesImportBatch.findUnique({ where: { fileHash } });
  if (duplicateBatch) throw new HttpError(409, `This workbook was already imported in batch #${duplicateBatch.id}`);
  const fileNameHeader = req.get("X-File-Name");
  const fileName = fileNameHeader ? decodeURIComponent(fileNameHeader).slice(0, 255) : null;

  const counts = await runSerializableTransaction(async (transaction) => {
    const productIds = [...new Set(plan.rows.map((row) => row.product.id))];
    const products = await transaction.product.findMany({ where: { id: { in: productIds }, isActive: true }, include: { inventory: true } });
    const productById = new Map(products.map((product) => [product.id, product]));
    const requestedByProduct = new Map();
    for (const row of plan.rows) requestedByProduct.set(row.product.id, (requestedByProduct.get(row.product.id) || 0) + row.stockQuantity);
    for (const [productId, quantity] of requestedByProduct) {
      const product = productById.get(productId);
      if (!product) throw new HttpError(409, "A product in this workbook is no longer active");
      const available = (product.inventory?.quantity || 0) - (product.inventory?.reservedQuantity || 0);
      if (available < quantity) throw new HttpError(409, `Only ${available} stock unit(s) of ${product.name} are now available`);
    }

    const [activeShift, inventoryStaff] = await Promise.all([
      transaction.shift.findFirst({ where: { userId: req.user.id, status: "OPEN" }, orderBy: { openedAt: "desc" }, select: { id: true } }),
      transaction.user.findMany({ where: { role: "INVENTORY_STAFF", isActive: true }, select: { id: true } }),
    ]);
    const createdIds = [];
    for (const row of plan.rows) {
      const product = productById.get(row.product.id);
      const saleNumber = makeSaleNumber(row.saleDate);
      const sale = await transaction.sale.create({ data: {
        saleNumber,
        cashierId: req.user.id,
        customerName: row.customerName,
        shiftId: activeShift?.id || null,
        totalAmount: centsToMoney(row.amountCents),
        creditBalance: centsToMoney(row.creditBalanceCents),
        status: "PENDING_RELEASE",
        createdAt: row.saleDate,
      } });
      const measurement = row.customMeasurement;
      // Priced per stock unit consumed, exactly like a live custom sale item
      // (see effectivePrice() * quantity in the cashier cart), not per piece.
      const unitPriceCents = row.amountCents / BigInt(row.stockQuantity);
      await transaction.saleItem.create({ data: {
        saleId: sale.id,
        productId: product.id,
        quantity: row.stockQuantity,
        unitPrice: centsToMoney(unitPriceCents),
        costPriceAtSale: product.costPrice,
        customLength: measurement?.length || null,
        customWidth: measurement?.width || null,
        customThickness: measurement?.thickness || null,
        cutLength: measurement?.cutLength || null,
        cutWidth: measurement?.cutWidth || null,
        cutThickness: measurement?.cutThickness || null,
        requestedPieces: measurement?.pieces || null,
        piecesPerStockUnit: row.piecesPerStockUnit || null,
      } });
      await transaction.inventory.update({ where: { productId: product.id }, data: { reservedQuantity: { increment: row.stockQuantity } } });
      if (row.collectedCents > 0n && row.paymentMethod !== "CREDIT") {
        await transaction.payment.create({ data: {
          saleId: sale.id,
          paymentMethod: row.paymentMethod,
          amount: centsToMoney(row.collectedCents),
          bankName: row.bankName,
          recipientAccount: row.recipientAccount,
          transactionReference: row.paymentMethod === "CASH" ? null : `EXCEL-${saleNumber}`,
          recordedById: req.user.id,
          createdAt: row.saleDate,
        } });
      }
      if (inventoryStaff.length) {
        const notification = buildSaleNotification({ saleNumber, customerName: null, items: [{ quantity: row.stockQuantity }] });
        await transaction.notification.createMany({ data: inventoryStaff.map((staff) => ({ userId: staff.id, saleId: sale.id, ...notification })) });
      }
      createdIds.push(sale.id);
    }

    const result = {
      sales: plan.rows.length,
      units: plan.rows.reduce((total, row) => total + row.stockQuantity, 0),
      amount: centsToMoney(plan.rows.reduce((total, row) => total + row.amountCents, 0n)),
      creditSales: plan.rows.filter((row) => row.creditBalanceCents > 0n).length,
      source: "StockFlow Sale Entry Excel",
      saleIds: createdIds,
    };
    await transaction.auditLog.create({ data: { userId: req.user.id, action: "IMPORT_SALES_WORKBOOK", entityType: "SALE", details: result } });
    try {
      await transaction.salesImportBatch.create({ data: { fileName, fileHash, summary: { sales: result.sales, units: result.units, amount: result.amount }, createdById: req.user.id } });
    } catch (error) {
      if (error.code === "P2002") throw new HttpError(409, "This workbook was already imported");
      throw error;
    }
    return result;
  }, 1, { maxWait: 15_000, timeout: 120_000 });

  return res.status(201).json({ success: true, message: `${counts.sales} sales imported and sent to warehouse release`, data: { counts } });
}

async function listSalesImportBatches(req, res) {
  const batches = await prisma.salesImportBatch.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
  return res.json({
    success: true,
    data: { batches: batches.map((batch) => ({ id: batch.id, fileName: batch.fileName, status: "IMPORTED", summary: batch.summary, createdAt: batch.createdAt, rolledBackAt: null })) },
  });
}

async function downloadSalesImportTemplate(req, res) {
  const templateVersion = "4";
  const products = await prisma.product.findMany({ where: { isActive: true }, include: { category: { select: { name: true } } }, orderBy: [{ name: "asc" }, { length: "desc" }] });
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "StockFlow";
  workbook.title = `StockFlow Sale Entry Import Template v${templateVersion}`;
  workbook.subject = "Bulk sale entry with customer size vs. stock cut size, and payment destinations";
  workbook.company = "StockFlow";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet("Sales Entry", { views: [{ state: "frozen", xSplit: 4, ySplit: 8, showGridLines: false }] });
  sheet.mergeCells("A1:S1"); sheet.getCell("A1").value = `STOCKFLOW SALE ENTRY IMPORT TEMPLATE · v${templateVersion}`;
  sheet.mergeCells("A2:S2"); sheet.getCell("A2").value = "One row per sale. Customer size is what the customer ordered; Stock cut size is optional and only needed when the actual cut differs from the order.";
  sheet.mergeCells("A4:C4"); sheet.getCell("A4").value = "CUSTOMER LINE TOTAL"; sheet.getCell("A5").value = { formula: "SUM(M9:M2008)", result: 0 };
  sheet.mergeCells("D4:F4"); sheet.getCell("D4").value = "AMOUNT RECEIVED"; sheet.getCell("D5").value = { formula: "SUM(N9:N2008)", result: 0 };
  sheet.mergeCells("G4:I4"); sheet.getCell("G4").value = "OUTSTANDING CREDIT"; sheet.getCell("G5").value = { formula: "SUM(O9:O2008)", result: 0 };
  sheet.mergeCells("J4:L4"); sheet.getCell("J4").value = "QUANTITY"; sheet.getCell("J5").value = { formula: "SUM(K9:K2008)", result: 0 };
  sheet.mergeCells("A7:S7"); sheet.getCell("A7").value = "ONE PRODUCT PER ROW — every row creates a real sale and reserves stock, exactly like the cashier sales screen";
  const headers = ["Date of Sale", "Customer Name", "Product Type", "Material / Product", "Customer Length (cm)", "Customer Width (cm)", "Customer Thickness (cm)", "Stock Cut Length (cm)", "Stock Cut Width (cm)", "Stock Cut Thickness (cm)", "Quantity", "Customer Price", "Customer Line Total", "Amount Received", "Outstanding Credit", "Payment Type", "Payment Destination", "Recipient Account No.", "Notes"];
  sheet.getRow(8).values = headers;
  sheet.columns = [{ width: 15 }, { width: 22 }, { width: 18 }, { width: 38 }, { width: 13 }, { width: 12 }, { width: 14 }, { width: 13 }, { width: 12 }, { width: 14 }, { width: 11 }, { width: 15 }, { width: 17 }, { width: 16 }, { width: 17 }, { width: 15 }, { width: 24 }, { width: 24 }, { width: 34 }];
  for (let row = 9; row <= 208; row += 1) {
    sheet.getCell(`P${row}`).dataValidation = { type: "list", allowBlank: false, formulae: ['"Bank Transfer,Credit,Cash,Mobile Money,Card"'] };
    sheet.getCell(`M${row}`).value = { formula: `IF(OR(K${row}="",L${row}=""),"",K${row}*L${row})`, result: "" };
    sheet.getCell(`O${row}`).value = { formula: `IF(M${row}="","",MAX(M${row}-IF(N${row}="",0,N${row}),0))`, result: "" };
    sheet.getCell(`A${row}`).numFmt = "yyyy-mm-dd";
    ["E", "F", "G", "H", "I", "J", "K"].forEach((column) => { sheet.getCell(`${column}${row}`).numFmt = "0"; });
    ["L", "M", "N", "O"].forEach((column) => { sheet.getCell(`${column}${row}`).numFmt = '#,##0.00 "ETB"'; });
  }
  sheet.getCell("C8").note = "Choose a product type from the Catalogue Guide dropdown.";
  sheet.getCell("D8").note = "Choose the exact product label from Catalogue Guide — this must be an existing, active catalogue item.";
  sheet.getCell("E8").note = "Leave Customer/Stock Cut size blank for a plain catalogue item sold at its own measurement. Fill in Customer Length, Width, and Thickness together for a custom-cut piece.";
  sheet.getCell("H8").note = "Optional. Only fill in Stock Cut Length/Width/Thickness when the piece actually cut differs from what the customer ordered (e.g. rounded up to the nearest size the slab supports). Leave blank to mean the cut matched the order exactly.";
  sheet.getCell("K8").note = "For a custom-cut item, this is the number of pieces wanted, not the number of stock slabs — StockFlow works out how many slabs that needs.";
  sheet.getCell("Q8").note = "For bank transfers, enter the bank or payment destination.";
  sheet.getRow(1).height = 34;
  sheet.getRow(1).eachCell((cell) => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF111111" } }; cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 18 }; });
  sheet.getRow(8).eachCell((cell) => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF176B5B" } }; cell.font = { bold: true, color: { argb: "FFFFFFFF" } }; cell.alignment = { wrapText: true, vertical: "middle" }; });
  sheet.getRow(8).height = 30;
  sheet.autoFilter = { from: "A8", to: "S208" };

  const recipients = workbook.addWorksheet("Recipient Destinations", { views: [{ state: "frozen", ySplit: 5, showGridLines: false }] });
  recipients.mergeCells("A1:D1"); recipients.getCell("A1").value = "PAYMENT RECIPIENT DESTINATIONS";
  recipients.mergeCells("A2:D2"); recipients.getCell("A2").value = "Reference list for bank accounts, people receiving funds, and Withold. Use Account not recorded until the real account number is available.";
  recipients.getRow(5).values = ["Destination Name", "Destination Type", "Account No.", "Notes"];
  recipients.columns = [{ width: 28 }, { width: 22 }, { width: 28 }, { width: 52 }];
  for (let row = 6; row <= 105; row += 1) recipients.getCell(`B${row}`).dataValidation = { type: "list", allowBlank: false, formulae: ['"Bank,Person,Withold"'] };

  const guide = workbook.addWorksheet("Catalogue Guide", { views: [{ state: "frozen", ySplit: 1, showGridLines: false }] });
  guide.columns = [{ header: "Product Type", key: "type", width: 22 }, { header: "Material / Product — paste this exact label", key: "label", width: 60 }, { header: "Available SKU", key: "sku", width: 28 }];
  products.forEach((product) => guide.addRow({ type: product.category?.name || product.name, label: productLabel(product), sku: product.sku }));
  guide.getRow(1).eachCell((cell) => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF111111" } }; cell.font = { bold: true, color: { argb: "FFFFFFFF" } }; });
  guide.autoFilter = { from: "A1", to: `C${Math.max(guide.rowCount, 2)}` };
  if (products.length) {
    const guideEndRow = products.length + 1;
    workbook.definedNames.add(`'Catalogue Guide'!$A$2:$A$${guideEndRow}`, "StockFlowProductTypes");
    workbook.definedNames.add(`'Catalogue Guide'!$B$2:$B$${guideEndRow}`, "StockFlowProductLabels");
    for (let row = 9; row <= 208; row += 1) {
      sheet.getCell(`C${row}`).dataValidation = { type: "list", allowBlank: true, formulae: ["StockFlowProductTypes"], showErrorMessage: false };
      sheet.getCell(`D${row}`).dataValidation = { type: "list", allowBlank: true, formulae: ["StockFlowProductLabels"], showErrorMessage: false };
    }
  }
  const instructions = workbook.addWorksheet("Instructions", { views: [{ showGridLines: false }] });
  instructions.getColumn(1).width = 110;
  [`STOCKFLOW SALE ENTRY IMPORT · TEMPLATE v${templateVersion}`, "Keep every header and sheet name unchanged.", "Material / Product must be an existing, active catalogue item chosen from the Catalogue Guide dropdown — this workbook does not create new products.", "Leave Customer Length/Width/Thickness blank to sell a plain catalogue item at its own measurement. Fill in all three together for a custom-cut piece, exactly like the cashier sales screen.", "Stock Cut Length/Width/Thickness is optional and only needed when the piece actually cut is a different size than what the customer ordered; leave it blank to mean the cut matched the order.", "Customer Line Total is Quantity × Customer Price. Amount Received is what was paid. The difference becomes Outstanding Credit.", "Use Bank Transfer or Mobile Money with a destination and account number, or Credit with no immediate payment.", "Every row creates a real sale, reserves stock, and is sent to warehouse release — just like ringing up a sale at the counter.", "Preview before importing. Importing the same workbook twice is blocked."].forEach((text) => instructions.addRow([text]));
  instructions.getCell("A1").font = { bold: true, size: 16 };

  recipients.getRow(1).height = 32;
  recipients.getRow(1).eachCell((cell) => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF111111" } }; cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 16 }; });
  recipients.getRow(5).eachCell((cell) => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF176B5B" } }; cell.font = { bold: true, color: { argb: "FFFFFFFF" } }; cell.alignment = { wrapText: true, vertical: "middle" }; });
  recipients.getRow(5).height = 28;

  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="stockflow-sale-entry-template-v${templateVersion}.xlsx"`);
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("X-StockFlow-Template-Version", templateVersion);
  return res.send(Buffer.from(buffer));
}

module.exports = {
  createSale,
  updateSale,
  recordCreditPayment,
  listSales,
  getSale,
  cancelSale,
  returnSale,
  previewSalesImport,
  importSales,
  listSalesImportBatches,
  downloadSalesImportTemplate,
  salesImportPlan,
  validateSaleRequest,
  sumQuantityByProduct,
};
