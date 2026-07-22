const prisma = require("../config/prisma");
const HttpError = require("../utils/HttpError");
const { moneyToCents, centsToMoney } = require("../utils/money");

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

  const from = query.from ? new Date(`${query.from}T00:00:00`) : defaultFrom;
  const to = query.to ? new Date(`${query.to}T23:59:59.999`) : new Date();

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    throw new HttpError(400, "Invalid report date range");
  }

  const maximumRange = 366 * 24 * 60 * 60 * 1000;
  if (to.getTime() - from.getTime() > maximumRange) {
    throw new HttpError(400, "Report date range cannot exceed 366 days");
  }

  return { from, to };
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
          select: { id: true, sku: true, name: true, costPrice: true, isActive: true },
        },
      },
    }),
    prisma.sale.findMany({
      take: 8,
      include: {
        cashier: { select: { fullName: true, username: true } },
        items: { select: { quantity: true, releasedQuantity: true } },
      },
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

  const lowStock = inventory
    .filter(
      (record) =>
        record.product.isActive &&
        record.quantity - record.reservedQuantity <= record.reorderLevel
    )
    .map((record) => ({
      productId: record.productId,
      sku: record.product.sku,
      name: record.product.name,
      physicalQuantity: record.quantity,
      reservedQuantity: record.reservedQuantity,
      availableQuantity: record.quantity - record.reservedQuantity,
      reorderLevel: record.reorderLevel,
    }));

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
      items: { select: { quantity: true, releasedQuantity: true } },
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
      include: { product: { select: { sku: true, name: true, isActive: true } } },
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
  const lowStock = inventory.filter(
    (record) =>
      record.product.isActive &&
      record.quantity - record.reservedQuantity <= record.reorderLevel
  );
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

module.exports = {
  getDashboard,
  getSalesReport,
  getPaymentReport,
};
