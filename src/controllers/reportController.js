const prisma = require("../config/prisma");
const HttpError = require("../utils/HttpError");
const { moneyToCents, centsToMoney } = require("../utils/money");
const { buildLowStockAlerts } = require("../utils/lowStock");
const { dashboardSaleInclude } = require("../utils/dashboardSaleInclude");

function todayStart() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function dayKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function sumMoney(values) {
  return centsToMoney(
    values.reduce(
      (total, value) => total + (moneyToCents(value?.toFixed?.(2) ?? value) || 0n),
      0n
    )
  );
}

function parseDateRange(query) {
  const defaultFrom = new Date();
  defaultFrom.setDate(defaultFrom.getDate() - 29);
  defaultFrom.setHours(0, 0, 0, 0);

  const parseBoundary = (value, endOfDay = false) => {
    if (!value) return undefined;
    const raw = String(value).trim();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
      ? new Date(`${raw}T${endOfDay ? "23:59:59.999" : "00:00:00"}`)
      : new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  };

  const parsedFrom = parseBoundary(query.from);
  const parsedTo = parseBoundary(query.to, true);
  const from = parsedFrom === undefined ? defaultFrom : parsedFrom;
  const to = parsedTo === undefined ? new Date() : parsedTo;

  if (!from || !to || from > to) {
    throw new HttpError(400, "Invalid report date range");
  }

  const maximumRange = 366 * 24 * 60 * 60 * 1000;
  if (to.getTime() - from.getTime() > maximumRange) {
    throw new HttpError(400, "Report date range cannot exceed 366 days");
  }

  return { from, to };
}

async function findAllById(model, args, batchSize = 2000) {
  const records = [];
  let cursor;

  while (true) {
    const batch = await model.findMany({
      ...args,
      orderBy: { id: "asc" },
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    records.push(...batch);
    if (batch.length < batchSize) return records;
    cursor = batch.at(-1).id;
  }
}

async function adminDashboard() {
  const start = todayStart();
  const trendStart = new Date(start);
  trendStart.setDate(trendStart.getDate() - 6);

  const [
    todaySales,
    pendingReleaseCount,
    inventory,
    recentSales,
    trendSales,
    payments,
  ] = await Promise.all([
    prisma.sale.findMany({
      where: { createdAt: { gte: start }, status: { not: "CANCELLED" } },
      select: { totalAmount: true, status: true },
    }),
    prisma.sale.count({
      where: { status: { in: ["PENDING_RELEASE", "PARTIALLY_RELEASED"] } },
    }),
    prisma.inventory.findMany({
      include: {
        product: {
          select: {
            id: true,
            sku: true,
            name: true,
            length: true,
            width: true,
            thickness: true,
            costPrice: true,
            isActive: true,
          },
        },
      },
    }),
    prisma.sale.findMany({
      take: 8,
      include: dashboardSaleInclude,
      orderBy: { createdAt: "desc" },
    }),
    prisma.sale.findMany({
      where: { createdAt: { gte: trendStart }, status: { not: "CANCELLED" } },
      select: { totalAmount: true, createdAt: true },
    }),
    prisma.payment.findMany({
      where: {
        createdAt: { gte: trendStart },
        status: "COMPLETED",
        sale: { status: { not: "CANCELLED" } },
      },
      select: { amount: true, paymentMethod: true, bankName: true },
    }),
  ]);

  const lowStock = buildLowStockAlerts(inventory);

  const inventoryValue = inventory.reduce((total, record) => {
    if (!record.product.costPrice) return total;
    return (
      total +
      moneyToCents(record.product.costPrice.toFixed(2)) * BigInt(record.quantity)
    );
  }, 0n);

  const trend = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const date = new Date(trendStart);
    date.setDate(date.getDate() + offset);
    const key = dayKey(date);
    const matching = trendSales.filter((sale) => dayKey(sale.createdAt) === key);
    trend.push({ date: key, sales: matching.length, revenue: sumMoney(matching.map((sale) => sale.totalAmount)) });
  }

  const paymentMethods = [...payments.reduce((groups, payment) => {
    const current = groups.get(payment.paymentMethod) || { count: 0, amounts: [] };
    current.count += 1;
    current.amounts.push(payment.amount);
    groups.set(payment.paymentMethod, current);
    return groups;
  }, new Map())].map(([paymentMethod, values]) => ({
    paymentMethod,
    count: values.count,
    amount: sumMoney(values.amounts),
  }));

  return {
    role: "ADMIN",
    metrics: {
      salesToday: todaySales.length,
      revenueToday: sumMoney(todaySales.map((sale) => sale.totalAmount)),
      pendingReleases: pendingReleaseCount,
      lowStockProducts: lowStock.length,
      inventoryValue: centsToMoney(inventoryValue),
    },
    trend,
    paymentMethods,
    lowStock: lowStock.slice(0, 8),
    recentSales,
  };
}

async function cashierDashboard(userId) {
  const start = todayStart();
  const sales = await prisma.sale.findMany({
    where: { cashierId: userId, createdAt: { gte: start } },
    take: 10,
    include: {
      ...dashboardSaleInclude,
      payments: true,
    },
    orderBy: { createdAt: "desc" },
  });
  const validSales = sales.filter((sale) => sale.status !== "CANCELLED");

  return {
    role: "CASHIER",
    metrics: {
      salesToday: validSales.length,
      revenueToday: sumMoney(validSales.map((sale) => sale.totalAmount)),
      awaitingRelease: validSales.filter((sale) =>
        ["PENDING_RELEASE", "PARTIALLY_RELEASED"].includes(sale.status)
      ).length,
      completedToday: validSales.filter((sale) => sale.status === "COMPLETED").length,
    },
    recentSales: sales,
  };
}

async function inventoryDashboard() {
  const [pendingSales, inventory, recentReceipts, recentReleases] = await Promise.all([
    prisma.sale.findMany({
      where: { status: { in: ["PENDING_RELEASE", "PARTIALLY_RELEASED"] } },
      include: { items: { select: { quantity: true, releasedQuantity: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.inventory.findMany({
      include: {
        product: {
          select: {
            sku: true,
            name: true,
            length: true,
            width: true,
            thickness: true,
            isActive: true,
          },
        },
      },
    }),
    prisma.stockReceipt.findMany({
      take: 5,
      include: { receivedBy: { select: { fullName: true } }, items: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.inventoryRelease.findMany({
      take: 5,
      include: {
        releasedBy: { select: { fullName: true } },
        sale: { select: { saleNumber: true } },
        items: true,
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  const lowStock = buildLowStockAlerts(inventory);
  const pendingUnits = pendingSales.reduce(
    (total, sale) =>
      total +
      sale.items.reduce(
        (itemTotal, item) => itemTotal + item.quantity - item.releasedQuantity,
        0
      ),
    0
  );

  return {
    role: "INVENTORY_STAFF",
    metrics: {
      pendingSales: pendingSales.length,
      pendingUnits,
      lowStockProducts: lowStock.length,
      physicalUnits: inventory.reduce((total, record) => total + record.quantity, 0),
    },
    recentReceipts,
    recentReleases,
  };
}

async function getDashboard(req, res) {
  let dashboard;
  if (req.user.role === "ADMIN") dashboard = await adminDashboard();
  if (req.user.role === "CASHIER") dashboard = await cashierDashboard(req.user.id);
  if (req.user.role === "INVENTORY_STAFF") dashboard = await inventoryDashboard();

  return res.json({ success: true, data: { dashboard } });
}

async function getLiveSalesSummary(req, res) {
  const { from, to } = parseDateRange(req.query);
  const sales = await findAllById(prisma.sale, {
    where: {
      createdAt: { gte: from, lte: to },
      status: { not: "CANCELLED" },
      ...(req.user.role === "CASHIER" ? { cashierId: req.user.id } : {}),
    },
    select: {
      id: true,
      totalAmount: true,
      discountAmount: true,
      status: true,
      payments: {
        where: { status: "COMPLETED" },
        select: { amount: true, paymentMethod: true },
      },
    },
  });

  const completedPayments = sales.flatMap((sale) => sale.payments);
  const paymentMethods = [...completedPayments.reduce((groups, payment) => {
    const current = groups.get(payment.paymentMethod) || { count: 0, amounts: [] };
    current.count += 1;
    current.amounts.push(payment.amount);
    groups.set(payment.paymentMethod, current);
    return groups;
  }, new Map())].map(([paymentMethod, values]) => ({
    paymentMethod,
    count: values.count,
    amount: sumMoney(values.amounts),
  }));

  return res.json({
    success: true,
    data: {
      range: { from, to },
      updatedAt: new Date(),
      metrics: {
        sales: sales.length,
        revenue: sumMoney(sales.map((sale) => sale.totalAmount)),
        discounts: sumMoney(sales.map((sale) => sale.discountAmount)),
        collected: sumMoney(completedPayments.map((payment) => payment.amount)),
        awaitingRelease: sales.filter((sale) => ["PENDING_RELEASE", "PARTIALLY_RELEASED"].includes(sale.status)).length,
        completed: sales.filter((sale) => sale.status === "COMPLETED").length,
      },
      paymentMethods,
    },
  });
}

async function getSalesReport(req, res) {
  const { from, to } = parseDateRange(req.query);
  const sales = await prisma.sale.findMany({
    where: { createdAt: { gte: from, lte: to } },
    take: 2000,
    include: {
      cashier: { select: { id: true, fullName: true, username: true } },
      items: { select: { quantity: true, costPriceAtSale: true, unitPrice: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  const validSales = sales.filter((sale) => sale.status !== "CANCELLED");

  const byStatus = [...sales.reduce((groups, sale) => {
    const current = groups.get(sale.status) || { count: 0, amounts: [] };
    current.count += 1;
    current.amounts.push(sale.totalAmount);
    groups.set(sale.status, current);
    return groups;
  }, new Map())].map(([status, values]) => ({
    status,
    count: values.count,
    amount: sumMoney(values.amounts),
  }));

  const byCashier = [...validSales.reduce((groups, sale) => {
    const key = sale.cashier.id;
    const current = groups.get(key) || {
      cashierId: key,
      fullName: sale.cashier.fullName,
      count: 0,
      amounts: [],
    };
    current.count += 1;
    current.amounts.push(sale.totalAmount);
    groups.set(key, current);
    return groups;
  }, new Map()).values()].map((entry) => ({
    cashierId: entry.cashierId,
    fullName: entry.fullName,
    count: entry.count,
    amount: sumMoney(entry.amounts),
  }));

  const estimatedProfitCents = validSales.reduce((total, sale) => {
    return total + sale.items.reduce((itemTotal, item) => {
      if (!item.costPriceAtSale) return itemTotal;
      const margin =
        moneyToCents(item.unitPrice.toFixed(2)) -
        moneyToCents(item.costPriceAtSale.toFixed(2));
      return itemTotal + margin * BigInt(item.quantity);
    }, 0n);
  }, 0n);

  return res.json({
    success: true,
    data: {
      range: { from, to },
      totals: {
        sales: validSales.length,
        revenue: sumMoney(validSales.map((sale) => sale.totalAmount)),
        estimatedProfit: centsToMoney(estimatedProfitCents),
      },
      byStatus,
      byCashier,
      sales,
    },
  });
}

async function getPaymentReport(req, res) {
  const { from, to } = parseDateRange(req.query);
  const payments = await prisma.payment.findMany({
    where: { createdAt: { gte: from, lte: to } },
    take: 3000,
    include: {
      sale: { select: { saleNumber: true, status: true } },
      recordedBy: { select: { fullName: true, username: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  const completed = payments.filter(
    (payment) => payment.status === "COMPLETED" && payment.sale.status !== "CANCELLED"
  );

  const byMethod = [...completed.reduce((groups, payment) => {
    const current = groups.get(payment.paymentMethod) || { count: 0, amounts: [] };
    current.count += 1;
    current.amounts.push(payment.amount);
    groups.set(payment.paymentMethod, current);
    return groups;
  }, new Map())].map(([paymentMethod, values]) => ({
    paymentMethod,
    count: values.count,
    amount: sumMoney(values.amounts),
  }));

  const byBank = [...completed
    .filter((payment) => payment.bankName)
    .reduce((groups, payment) => {
      const current = groups.get(payment.bankName) || { count: 0, amounts: [] };
      current.count += 1;
      current.amounts.push(payment.amount);
      groups.set(payment.bankName, current);
      return groups;
    }, new Map())].map(([bankName, values]) => ({
    bankName,
    count: values.count,
    amount: sumMoney(values.amounts),
  }));

  return res.json({
    success: true,
    data: {
      range: { from, to },
      totalCollected: sumMoney(completed.map((payment) => payment.amount)),
      byMethod,
      byBank,
      payments,
    },
  });
}

function percentage(numerator, denominator) {
  if (denominator === 0n) return 0;
  return Number((numerator * 10_000n) / denominator) / 100;
}

function createProfitBucket(identity = {}) {
  return {
    ...identity,
    units: 0,
    missingCostUnits: 0,
    revenueCents: 0n,
    costedRevenueCents: 0n,
    costOfGoodsCents: 0n,
  };
}

function addProfitLine(bucket, item) {
  const quantity = BigInt(item.quantity);
  const revenueCents = moneyToCents(item.unitPrice.toFixed(2)) * quantity;
  bucket.units += item.quantity;
  bucket.revenueCents += revenueCents;

  if (item.costPriceAtSale === null) {
    bucket.missingCostUnits += item.quantity;
    return;
  }

  bucket.costedRevenueCents += revenueCents;
  bucket.costOfGoodsCents +=
    moneyToCents(item.costPriceAtSale.toFixed(2)) * quantity;
}

function serializeProfitBucket(bucket) {
  const grossProfitCents =
    bucket.costedRevenueCents - bucket.costOfGoodsCents;

  return {
    ...Object.fromEntries(
      Object.entries(bucket).filter(
        ([key]) =>
          ![
            "revenueCents",
            "costedRevenueCents",
            "costOfGoodsCents",
          ].includes(key)
      )
    ),
    revenue: centsToMoney(bucket.revenueCents),
    trackedRevenue: centsToMoney(bucket.costedRevenueCents),
    costOfGoods: centsToMoney(bucket.costOfGoodsCents),
    grossProfit: centsToMoney(grossProfitCents),
    grossMarginPercent: percentage(
      grossProfitCents,
      bucket.costedRevenueCents
    ),
    costCoveragePercent: percentage(
      bucket.costedRevenueCents,
      bucket.revenueCents
    ),
  };
}

async function getProfitReport(req, res) {
  const { from, to } = parseDateRange(req.query);
  const items = await prisma.saleItem.findMany({
    where: {
      sale: {
        createdAt: { gte: from, lte: to },
        status: { not: "CANCELLED" },
      },
    },
    take: 5000,
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
      sale: {
        select: {
          createdAt: true,
          cashier: { select: { id: true, fullName: true } },
        },
      },
    },
    orderBy: { id: "desc" },
  });

  const totals = createProfitBucket();
  const productBuckets = new Map();
  const cashierBuckets = new Map();
  const dailyBuckets = new Map();

  for (const item of items) {
    addProfitLine(totals, item);

    if (!productBuckets.has(item.productId)) {
      productBuckets.set(
        item.productId,
        createProfitBucket({
          productId: item.productId,
          sku: item.product.sku,
          name: item.product.name,
          length: item.product.length,
          width: item.product.width,
          thickness: item.product.thickness,
        })
      );
    }
    addProfitLine(productBuckets.get(item.productId), item);

    const cashierId = item.sale.cashier.id;
    if (!cashierBuckets.has(cashierId)) {
      cashierBuckets.set(
        cashierId,
        createProfitBucket({
          cashierId,
          fullName: item.sale.cashier.fullName,
        })
      );
    }
    addProfitLine(cashierBuckets.get(cashierId), item);

    const date = dayKey(item.sale.createdAt);
    if (!dailyBuckets.has(date)) {
      dailyBuckets.set(date, createProfitBucket({ date }));
    }
    addProfitLine(dailyBuckets.get(date), item);
  }

  const byProduct = [...productBuckets.values()]
    .map(serializeProfitBucket)
    .sort((left, right) => Number(right.grossProfit) - Number(left.grossProfit));
  const byCashier = [...cashierBuckets.values()]
    .map(serializeProfitBucket)
    .sort((left, right) => Number(right.grossProfit) - Number(left.grossProfit));
  const trend = [...dailyBuckets.values()]
    .map(serializeProfitBucket)
    .sort((left, right) => left.date.localeCompare(right.date));

  return res.json({
    success: true,
    data: {
      range: { from, to },
      totals: serializeProfitBucket(totals),
      byProduct,
      byCashier,
      trend,
    },
  });
}

async function getLowStockAlerts(req, res) {
  const inventory = await prisma.inventory.findMany({
    include: {
      product: {
        select: {
          id: true,
          sku: true,
          name: true,
          length: true,
          width: true,
          thickness: true,
          isActive: true,
        },
      },
    },
  });
  const alerts = buildLowStockAlerts(inventory);
  const summary = alerts.reduce(
    (counts, alert) => {
      counts.total += 1;
      counts[alert.severity] += 1;
      return counts;
    },
    { total: 0, OUT_OF_STOCK: 0, CRITICAL: 0, LOW: 0 }
  );

  return res.json({ success: true, data: { alerts, summary } });
}

async function getTopSellingReport(req, res) {
  const { from, to } = parseDateRange(req.query);
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const items = await findAllById(prisma.saleItem, {
    where: {
      sale: { createdAt: { gte: from, lte: to }, status: { not: "CANCELLED" } },
    },
    include: {
      product: {
        select: { id: true, sku: true, name: true, length: true, width: true, thickness: true },
      },
    },
  });
  const buckets = new Map();
  for (const item of items) {
    const bucket = buckets.get(item.productId) || {
      product: item.product,
      quantity: 0,
      revenueCents: 0n,
    };
    bucket.quantity += item.quantity;
    bucket.revenueCents += moneyToCents(item.unitPrice.toFixed(2)) * BigInt(item.quantity);
    buckets.set(item.productId, bucket);
  }
  const products = [...buckets.values()]
    .map((bucket) => ({
      product: bucket.product,
      quantity: bucket.quantity,
      revenue: centsToMoney(bucket.revenueCents),
    }))
    .sort((left, right) => right.quantity - left.quantity || Number(right.revenue) - Number(left.revenue))
    .slice(0, limit);
  return res.json({ success: true, data: { range: { from, to }, products } });
}

async function getDeadStockReport(req, res) {
  const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 3650);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const inventory = await prisma.inventory.findMany({
    where: { product: { isActive: true } },
    include: {
      product: {
        include: {
          saleItems: {
            where: { sale: { status: { not: "CANCELLED" } } },
            select: { sale: { select: { createdAt: true } } },
            orderBy: { sale: { createdAt: "desc" } },
            take: 1,
          },
        },
      },
    },
    orderBy: { quantity: "desc" },
  });
  const products = inventory
    .map((record) => {
      const lastSoldAt = record.product.saleItems[0]?.sale.createdAt || null;
      return {
        product: {
          id: record.product.id,
          sku: record.product.sku,
          name: record.product.name,
          length: record.product.length,
          width: record.product.width,
          thickness: record.product.thickness,
        },
        quantity: record.quantity,
        reservedQuantity: record.reservedQuantity,
        lastSoldAt,
        daysSinceLastSale: lastSoldAt
          ? Math.floor((Date.now() - lastSoldAt.getTime()) / (24 * 60 * 60 * 1000))
          : null,
      };
    })
    .filter((record) => record.quantity > 0 && (!record.lastSoldAt || record.lastSoldAt < cutoff));
  return res.json({
    success: true,
    data: {
      cutoff,
      days,
      products,
      totalUnits: products.reduce((sum, product) => sum + product.quantity, 0),
    },
  });
}

async function getProfitLossReport(req, res) {
  const { from, to } = parseDateRange(req.query);
  const [sales, items] = await Promise.all([
    findAllById(prisma.sale, {
      where: { createdAt: { gte: from, lte: to }, status: { not: "CANCELLED" } },
      select: { id: true, totalAmount: true, discountAmount: true },
    }),
    findAllById(prisma.saleItem, {
      where: { sale: { createdAt: { gte: from, lte: to }, status: { not: "CANCELLED" } } },
      select: { id: true, quantity: true, unitPrice: true, costPriceAtSale: true },
    }),
  ]);
  const netRevenueCents = sales.reduce(
    (total, sale) => total + moneyToCents(sale.totalAmount.toFixed(2)),
    0n
  );
  const discountCents = sales.reduce(
    (total, sale) => total + moneyToCents(sale.discountAmount.toFixed(2)),
    0n
  );
  const grossRevenueCents = netRevenueCents + discountCents;
  let costOfGoodsCents = 0n;
  let missingCostUnits = 0;
  for (const item of items) {
    if (item.costPriceAtSale === null) {
      missingCostUnits += item.quantity;
      continue;
    }
    costOfGoodsCents += moneyToCents(item.costPriceAtSale.toFixed(2)) * BigInt(item.quantity);
  }
  const grossProfitCents = netRevenueCents - costOfGoodsCents;
  return res.json({
    success: true,
    data: {
      range: { from, to },
      sales: sales.length,
      units: items.reduce((sum, item) => sum + item.quantity, 0),
      grossRevenue: centsToMoney(grossRevenueCents),
      discounts: centsToMoney(discountCents),
      netRevenue: centsToMoney(netRevenueCents),
      costOfGoods: centsToMoney(costOfGoodsCents),
      grossProfit: centsToMoney(grossProfitCents),
      grossMarginPercent: percentage(grossProfitCents, netRevenueCents),
      missingCostUnits,
      note: "Operating expenses are not stored in StockFlow; this report shows sales less tracked cost of goods.",
    },
  });
}

async function getValuationReport(req, res) {
  const inventory = await prisma.inventory.findMany({
    where: { product: { isActive: true } },
    include: {
      product: {
        select: {
          id: true,
          sku: true,
          name: true,
          length: true,
          width: true,
          thickness: true,
          costPrice: true,
        },
      },
    },
    orderBy: { product: { name: "asc" } },
  });
  let trackedValueCents = 0n;
  let missingCostUnits = 0;
  const products = inventory.map((record) => {
    const costCents = record.product.costPrice
      ? moneyToCents(record.product.costPrice.toFixed(2))
      : null;
    const valueCents = costCents === null ? null : costCents * BigInt(record.quantity);
    if (valueCents === null) missingCostUnits += record.quantity;
    else trackedValueCents += valueCents;
    return {
      product: record.product,
      quantity: record.quantity,
      reservedQuantity: record.reservedQuantity,
      availableQuantity: record.quantity - record.reservedQuantity,
      value: valueCents === null ? null : centsToMoney(valueCents),
    };
  });
  return res.json({
    success: true,
    data: {
      asOf: new Date(),
      physicalUnits: inventory.reduce((sum, record) => sum + record.quantity, 0),
      trackedValue: centsToMoney(trackedValueCents),
      missingCostUnits,
      products,
    },
  });
}

module.exports = {
  getDashboard,
  getLiveSalesSummary,
  getSalesReport,
  getPaymentReport,
  getProfitReport,
  getLowStockAlerts,
  getTopSellingReport,
  getDeadStockReport,
  getProfitLossReport,
  getValuationReport,
};
