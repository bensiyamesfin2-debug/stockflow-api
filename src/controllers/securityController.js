const prisma = require("../config/prisma");
const bcrypt = require("bcrypt");
const { encryptJsonBackup } = require("../utils/backupEncryption");
const { generateSecret, verifyCode, provisioningUri } = require("../utils/totp");
const { instanceIdentity } = require("../utils/instanceIdentity");

async function getSecurityStatus(req, res) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      lastLoginAt: true,
      passwordChangedAt: true,
      twoFactorEnabled: true,
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

async function startTwoFactorSetup(req, res) {
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { username: true } });
  const secret = generateSecret();
  await prisma.user.update({ where: { id: req.user.id }, data: { twoFactorSecret: secret, twoFactorEnabled: false } });
  await prisma.auditLog.create({ data: { userId: req.user.id, action: "TWO_FACTOR_SETUP_STARTED", entityType: "USER", entityId: req.user.id } });
  return res.json({ success: true, data: { provisioningUri: provisioningUri(secret, user.username), manualKey: secret } });
}

async function verifyTwoFactorSetup(req, res) {
  const code = String(req.body.code || "");
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { twoFactorSecret: true } });
  if (!user?.twoFactorSecret || !verifyCode(user.twoFactorSecret, code)) return res.status(400).json({ success: false, message: "That code did not match. Try the newest code from your authenticator app." });
  await prisma.$transaction([
    prisma.user.update({ where: { id: req.user.id }, data: { twoFactorEnabled: true } }),
    prisma.auditLog.create({ data: { userId: req.user.id, action: "TWO_FACTOR_ENABLED", entityType: "USER", entityId: req.user.id } }),
  ]);
  return res.json({ success: true, message: "Two-factor authentication is enabled" });
}

async function disableTwoFactor(req, res) {
  const code = String(req.body.code || "");
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { twoFactorSecret: true, twoFactorEnabled: true } });
  if (!user?.twoFactorEnabled || !user.twoFactorSecret || !verifyCode(user.twoFactorSecret, code)) return res.status(400).json({ success: false, message: "Enter a valid authenticator code to turn off two-factor authentication" });
  await prisma.$transaction([
    prisma.user.update({ where: { id: req.user.id }, data: { twoFactorEnabled: false, twoFactorSecret: null, tokenVersion: { increment: 1 } } }),
    prisma.auditLog.create({ data: { userId: req.user.id, action: "TWO_FACTOR_DISABLED", entityType: "USER", entityId: req.user.id } }),
  ]);
  return res.json({ success: true, message: "Two-factor authentication is disabled. Sign in again." });
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
        inventoryLocations,
        inventoryLocationBalances,
        stockBatches,
        deliveryProofs,
        priceLists,
        priceListItems,
        stockTransfers,
        stockTransferItems,
        quotations,
        quotationItems,
        saleReturns,
        saleReturnItems,
        workspaceSettings,
        workspaceNotes,
        calendarEvents,
        favorites,
        fileAttachments,
        invoiceTemplates,
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
        transaction.inventoryLocation.findMany({ orderBy: { id: "asc" } }),
        transaction.inventoryLocationBalance.findMany({ orderBy: { id: "asc" } }),
        transaction.stockBatch.findMany({ orderBy: { id: "asc" } }),
        transaction.deliveryProof.findMany({ orderBy: { id: "asc" } }),
        transaction.priceList.findMany({ orderBy: { id: "asc" } }),
        transaction.priceListItem.findMany({ orderBy: { id: "asc" } }),
        transaction.stockTransfer.findMany({ orderBy: { id: "asc" } }),
        transaction.stockTransferItem.findMany({ orderBy: { id: "asc" } }),
        transaction.quotation.findMany({ orderBy: { id: "asc" } }),
        transaction.quotationItem.findMany({ orderBy: { id: "asc" } }),
        transaction.saleReturn.findMany({ orderBy: { id: "asc" } }),
        transaction.saleReturnItem.findMany({ orderBy: { id: "asc" } }),
        transaction.workspaceSettings.findMany({ orderBy: { id: "asc" } }),
        transaction.workspaceNote.findMany({ orderBy: { id: "asc" } }),
        transaction.calendarEvent.findMany({ orderBy: { id: "asc" } }),
        transaction.favorite.findMany({ orderBy: { id: "asc" } }),
        transaction.fileAttachment.findMany({ orderBy: { id: "asc" } }),
        transaction.invoiceTemplate.findMany({ orderBy: { id: "asc" } }),
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
        inventoryLocations,
        inventoryLocationBalances,
        stockBatches,
        deliveryProofs,
        priceLists,
        priceListItems,
        stockTransfers,
        stockTransferItems,
        quotations,
        quotationItems,
        saleReturns,
        saleReturnItems,
        workspaceSettings,
        workspaceNotes,
        calendarEvents,
        favorites,
        fileAttachments,
        invoiceTemplates,
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
    schemaVersion: 3,
    instanceCompanyCode: instanceIdentity.companyCode,
    instanceTenantKey: instanceIdentity.tenantKey,
    isolationMode: instanceIdentity.dataIsolationMode,
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

async function getHandoverResetPreview(req, res) {
  const [sales, payments, releases, returns, physicalUnits, reservedUnits, activeBatches] = await Promise.all([
    prisma.sale.count(), prisma.payment.count(), prisma.inventoryRelease.count(), prisma.saleReturn.count(),
    prisma.inventory.aggregate({ _sum: { quantity: true } }), prisma.inventory.aggregate({ _sum: { reservedQuantity: true } }),
    prisma.stockBatch.count({ where: { availableQuantity: { gt: 0 } } }),
  ]);
  return res.json({ success: true, data: { sales, payments, releases, returns, physicalUnits: physicalUnits._sum.quantity || 0, reservedUnits: reservedUnits._sum.reservedQuantity || 0, activeBatches } });
}

async function resetSalesAndInventory(req, res) {
  const confirmation = String(req.body.confirmation || "").trim();
  const password = String(req.body.password || "");
  if (confirmation !== "RESET SALES AND INVENTORY") {
    return res.status(400).json({ success: false, message: "Type RESET SALES AND INVENTORY exactly to confirm" });
  }
  const administrator = await prisma.user.findUnique({ where: { id: req.user.id }, select: { passwordHash: true } });
  if (!administrator || !(await bcrypt.compare(password, administrator.passwordHash))) {
    return res.status(403).json({ success: false, message: "Administrator password is incorrect" });
  }

  const result = await prisma.$transaction(async (transaction) => {
    const counts = {
      sales: await transaction.sale.count(),
      payments: await transaction.payment.count(),
      releases: await transaction.inventoryRelease.count(),
      returns: await transaction.saleReturn.count(),
      productsPreserved: await transaction.product.count(),
      categoriesPreserved: await transaction.category.count(),
    };
    await transaction.deliveryProof.deleteMany();
    await transaction.inventoryReleaseItem.deleteMany();
    await transaction.saleReturnItem.deleteMany();
    await transaction.payment.deleteMany();
    await transaction.inventoryRelease.deleteMany();
    await transaction.saleReturn.deleteMany();
    await transaction.notification.deleteMany({ where: { saleId: { not: null } } });
    await transaction.inventoryMovement.deleteMany({ where: { referenceType: { in: ["INVENTORY_RELEASE", "SALE_RETURN"] } } });
    await transaction.auditLog.deleteMany({ where: { OR: [{ entityType: { in: ["SALE", "SALE_RETURN", "INVENTORY_RELEASE"] } }, { action: { in: ["CREATE_SALE", "UPDATE_SALE", "CANCEL_SALE", "COLLECT_CREDIT_PAYMENT", "RETURN_SALE", "RELEASE_INVENTORY", "CONFIRM_DELIVERY"] } }] } });
    await transaction.saleItem.deleteMany();
    await transaction.sale.deleteMany();
    await transaction.shift.deleteMany();
    await transaction.inventory.updateMany({ data: { quantity: 0, reservedQuantity: 0 } });
    await transaction.inventoryLocationBalance.updateMany({ data: { quantity: 0 } });
    await transaction.stockBatch.updateMany({ data: { availableQuantity: 0 } });
    await transaction.discount.updateMany({ data: { usageCount: 0 } });
    await transaction.auditLog.create({ data: { userId: req.user.id, action: "HANDOVER_RESET_SALES_AND_INVENTORY", entityType: "SYSTEM", details: counts } });
    return counts;
  }, { isolationLevel: "Serializable", timeout: 30000 });
  return res.json({ success: true, message: "Sales history and current inventory were cleared. The product catalogue was preserved.", data: { result } });
}

module.exports = { getSecurityStatus, createEncryptedBackup, startTwoFactorSetup, verifyTwoFactorSetup, disableTwoFactor, getHandoverResetPreview, resetSalesAndInventory };
