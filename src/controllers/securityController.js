const prisma = require("../config/prisma");
const { encryptJsonBackup } = require("../utils/backupEncryption");

async function getSecurityStatus(req, res) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      lastLoginAt: true,
      passwordChangedAt: true,
    },
  });

  const data = {
    user,
    protections: {
      passwordHashing: true,
      accountLockout: true,
      maximumFailedAttempts: 5,
      lockMinutes: 15,
      sessionDuration: process.env.JWT_EXPIRES_IN || "8h",
      encryptedBackups: true,
    },
  };

  if (req.user.role === "ADMIN") {
    const [lastBackup, failedLogins24h, lockedAccounts] = await Promise.all([
      prisma.auditLog.findFirst({
        where: { action: "CREATE_ENCRYPTED_BACKUP" },
        select: { createdAt: true },
        orderBy: { createdAt: "desc" },
      }),
      prisma.auditLog.count({
        where: {
          action: { in: ["LOGIN_FAILED", "ACCOUNT_LOCKED"] },
          createdAt: { gte: since },
        },
      }),
      prisma.user.count({ where: { lockedUntil: { gt: new Date() } } }),
    ]);

    data.workspace = {
      failedLogins24h,
      lockedAccounts,
      lastBackupAt: lastBackup?.createdAt || null,
      backupRecommended: !lastBackup ||
        Date.now() - lastBackup.createdAt.getTime() > 7 * 24 * 60 * 60 * 1000,
    };
  }

  return res.json({ success: true, data });
}

async function createEncryptedBackup(req, res) {
  const passphrase = String(req.body.passphrase || "");

  if (passphrase.length < 12 || passphrase.length > 128) {
    return res.status(400).json({
      success: false,
      message: "Backup password must be between 12 and 128 characters",
    });
  }

  const data = await prisma.$transaction(
    async (transaction) => {
      const [
        users,
        products,
        inventory,
        sales,
        saleItems,
        payments,
        inventoryReleases,
        inventoryReleaseItems,
        stockReceipts,
        stockReceiptItems,
        inventoryMovements,
        auditLogs,
        salesLeads,
        categories,
        suppliers,
        customers,
        purchaseOrders,
        purchaseOrderItems,
        stockCounts,
        stockCountItems,
        discounts,
        shifts,
      ] = await Promise.all([
        transaction.user.findMany({ orderBy: { id: "asc" } }),
        transaction.product.findMany({ orderBy: { id: "asc" } }),
        transaction.inventory.findMany({ orderBy: { id: "asc" } }),
        transaction.sale.findMany({ orderBy: { id: "asc" } }),
        transaction.saleItem.findMany({ orderBy: { id: "asc" } }),
        transaction.payment.findMany({ orderBy: { id: "asc" } }),
        transaction.inventoryRelease.findMany({ orderBy: { id: "asc" } }),
        transaction.inventoryReleaseItem.findMany({ orderBy: { id: "asc" } }),
        transaction.stockReceipt.findMany({ orderBy: { id: "asc" } }),
        transaction.stockReceiptItem.findMany({ orderBy: { id: "asc" } }),
        transaction.inventoryMovement.findMany({ orderBy: { id: "asc" } }),
        transaction.auditLog.findMany({ orderBy: { id: "asc" } }),
        transaction.salesLead.findMany({ orderBy: { id: "asc" } }),
        transaction.category.findMany({ orderBy: { id: "asc" } }),
        transaction.supplier.findMany({ orderBy: { id: "asc" } }),
        transaction.customer.findMany({ orderBy: { id: "asc" } }),
        transaction.purchaseOrder.findMany({ orderBy: { id: "asc" } }),
        transaction.purchaseOrderItem.findMany({ orderBy: { id: "asc" } }),
        transaction.stockCount.findMany({ orderBy: { id: "asc" } }),
        transaction.stockCountItem.findMany({ orderBy: { id: "asc" } }),
        transaction.discount.findMany({ orderBy: { id: "asc" } }),
        transaction.shift.findMany({ orderBy: { id: "asc" } }),
      ]);

      return {
        users,
        products,
        inventory,
        sales,
        saleItems,
        payments,
        inventoryReleases,
        inventoryReleaseItems,
        stockReceipts,
        stockReceiptItems,
        inventoryMovements,
        auditLogs,
        salesLeads,
        categories,
        suppliers,
        customers,
        purchaseOrders,
        purchaseOrderItems,
        stockCounts,
        stockCountItems,
        discounts,
        shifts,
      };
    },
    {
      isolationLevel: "RepeatableRead",
      maxWait: 5000,
      timeout: 20000,
    }
  );

  const recordCounts = Object.fromEntries(
    Object.entries(data).map(([name, rows]) => [name, rows.length])
  );
  const payload = {
    schemaVersion: 2,
    application: "StockFlow",
    exportedAt: new Date().toISOString(),
    recordCounts,
    data,
  };
  const encryptedBackup = encryptJsonBackup(payload, passphrase);

  await prisma.auditLog.create({
    data: {
      userId: req.user.id,
      action: "CREATE_ENCRYPTED_BACKUP",
      entityType: "SYSTEM",
      details: { recordCounts },
    },
  });

  const date = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="stockflow-backup-${date}.json"`
  );
  res.setHeader("Cache-Control", "no-store");
  return res.send(JSON.stringify(encryptedBackup, null, 2));
}

module.exports = { getSecurityStatus, createEncryptedBackup };
