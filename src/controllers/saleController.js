const { randomUUID } = require("crypto");
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

function makeSaleNumber() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
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
      item.unitPriceCents = saleUnitPriceCents(product, pricesByProduct);
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

    await transaction.auditLog.create({
      data: {
        userId: req.user.id,
        action: "CREATE_SALE",
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
      item.unitPriceCents = saleUnitPriceCents(product, pricesByProduct);
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
          customerId: customer?.id || null,
          priceListId: priceList?.id || null,
          discountId: discount?.id || null,
          discountAmount: centsToMoney(discountCents),
          creditBalance: centsToMoney(creditBalanceCents),
          creditDueAt: creditBalanceCents > 0n ? data.creditDueAt : null,
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
  const transactionReference = String(req.body.transactionReference || "").trim() || null;
  if (!Number.isInteger(saleId) || saleId <= 0 || !PAYMENT_METHODS.has(paymentMethod) || amountCents === null || amountCents <= 0n) {
    return res.status(400).json({ success: false, message: "Enter a valid payment method and amount" });
  }
  if (bankName && bankName.length > 150) return res.status(400).json({ success: false, message: "Bank name cannot exceed 150 characters" });
  if (transactionReference && transactionReference.length > 150) return res.status(400).json({ success: false, message: "Transaction reference cannot exceed 150 characters" });
  if (paymentMethod === "BANK_TRANSFER" && !bankName) return res.status(400).json({ success: false, message: "Bank transfer requires a bank name" });
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
        transactionReference: paymentMethod === "CASH" ? null : transactionReference,
        amount: centsToMoney(amountCents),
        recordedById: req.user.id,
      },
    });
    const updated = await transaction.sale.update({ where: { id: saleId }, data: { creditBalance: centsToMoney(remainingCents - amountCents) }, include: saleInclude });
    await transaction.auditLog.create({ data: { userId: req.user.id, action: "COLLECT_CREDIT_PAYMENT", entityType: "SALE", entityId: saleId, details: { saleNumber: existing.saleNumber, amount: centsToMoney(amountCents), paymentMethod, remainingBalance: centsToMoney(remainingCents - amountCents) } } });
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

module.exports = {
  createSale,
  updateSale,
  recordCreditPayment,
  listSales,
  getSale,
  cancelSale,
  returnSale,
  validateSaleRequest,
  sumQuantityByProduct,
};
