require("dotenv").config();

const { randomBytes } = require("crypto");
const bcrypt = require("bcrypt");
const prisma = require("../config/prisma");
const { makeInternalSku } = require("../utils/productCatalog");
const { validateNewUser } = require("../controllers/userController");

const PRODUCT_FAMILIES = [
  "603",
  "664",
  "602",
  "Spray White",
  "664 Old",
  "Black Galaxy",
  "River Black",
  "Tiger Skin",
];

// The 66 L × W × T entries transcribed from Sayin's supplied weekly report.
const MEASUREMENTS = [
  [220, 34, 3], [200, 34, 3], [180, 34, 3], [160, 34, 3], [150, 34, 3],
  [140, 34, 3], [130, 34, 3], [125, 34, 3], [120, 34, 3], [115, 34, 3],
  [220, 30, 3], [200, 30, 3], [180, 30, 3], [160, 30, 3], [150, 30, 3],
  [140, 30, 3], [125, 30, 3],
  [220, 28, 3], [200, 28, 3], [180, 28, 3], [160, 28, 3], [150, 28, 3],
  [140, 28, 3], [125, 28, 3],
  [220, 25, 3], [200, 25, 3], [180, 25, 3], [160, 25, 3], [150, 25, 3],
  [140, 25, 3], [125, 25, 3],
  [240, 63, 2], [220, 63, 2],
  [220, 50, 2], [200, 50, 2], [180, 50, 2], [160, 50, 2], [150, 50, 2],
  [140, 50, 2], [125, 50, 2],
  [220, 40, 2], [200, 40, 2], [180, 40, 2], [160, 40, 2], [150, 40, 2],
  [140, 40, 2], [125, 40, 2],
  [220, 30, 2], [200, 30, 2], [180, 30, 2], [160, 30, 2], [150, 30, 2],
  [125, 30, 2],
  [200, 25, 2], [180, 25, 2], [160, 25, 2], [150, 25, 2], [140, 25, 2],
  [125, 25, 2],
  [200, 20, 2], [180, 20, 2], [160, 20, 2], [150, 20, 2], [140, 20, 2],
  [125, 20, 2],
  [40, 40, 1],
];

const STAFF = [
  { fullName: "Mesfin Murga", username: "mesfin", role: "ADMIN" },
  { fullName: "Ase", username: "ase", role: "CASHIER" },
  { fullName: "Tame", username: "tame", role: "INVENTORY_STAFF" },
  { fullName: "Tina", username: "tina", role: "INVENTORY_STAFF" },
  { fullName: "Meklit", username: "meklit", role: "INVENTORY_STAFF" },
];

const RESET_DATABASE_SQL = `
  TRUNCATE TABLE
    "inventory_release_items",
    "inventory_releases",
    "sale_items",
    "payments",
    "notifications",
    "sales",
    "inventory_movements",
    "stock_receipt_items",
    "stock_receipts",
    "purchase_order_items",
    "purchase_orders",
    "stock_count_items",
    "stock_counts",
    "shifts",
    "inventory",
    "products",
    "customers",
    "suppliers",
    "categories",
    "discounts",
    "push_subscriptions",
    "login_pairings",
    "audit_logs",
    "users"
  RESTART IDENTITY CASCADE;
`;

function buildTrialProducts(categoryId) {
  return PRODUCT_FAMILIES.flatMap((name) =>
    MEASUREMENTS.map(([length, width, thickness]) => ({
      sku: makeInternalSku(name, length, width, thickness),
      name,
      length,
      width,
      thickness,
      sellingPrice: "0.00",
      categoryId,
      isActive: true,
    }))
  );
}

function makeTemporaryPassword() {
  return `Sgi!${randomBytes(12).toString("base64url")}`;
}

function resolveTrialCredentials() {
  const rawCredentials = process.env.SAYIN_TRIAL_CREDENTIALS;

  if (!rawCredentials) {
    return STAFF.map((member) => ({
      ...member,
      password: makeTemporaryPassword(),
    }));
  }

  let suppliedPasswords;
  try {
    suppliedPasswords = JSON.parse(rawCredentials);
  } catch {
    // Railway variables can retain shell quotes around JSON. Extracting the
    // named values keeps this one-time bootstrap independent of that wrapper.
    suppliedPasswords = Object.fromEntries(
      STAFF.map((member) => {
        const escapedUsername = member.username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const match = rawCredentials.match(
          new RegExp(`(?:["']?${escapedUsername}["']?)\\s*:\\s*["']?([^,"'\\s}]+)`, "i")
        );
        return [member.username, match?.[1]];
      })
    );
  }

  if (!suppliedPasswords || Array.isArray(suppliedPasswords)) {
    throw new Error("SAYIN_TRIAL_CREDENTIALS must map usernames to passwords");
  }

  return STAFF.map((member) => {
    const password = suppliedPasswords[member.username];
    if (typeof password !== "string") {
      throw new Error(`A temporary password is required for ${member.username}`);
    }
    return { ...member, password };
  });
}

function validateStaff(staff) {
  for (const member of staff) {
    const validationError = validateNewUser(member);
    if (validationError) {
      throw new Error(`Invalid trial account for ${member.username}: ${validationError}`);
    }
  }
}

async function currentCounts() {
  const [
    users,
    products,
    inventory,
    sales,
    receipts,
    releases,
    movements,
    notifications,
    customers,
    suppliers,
    purchaseOrders,
    stockCounts,
    shifts,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.product.count(),
    prisma.inventory.count(),
    prisma.sale.count(),
    prisma.stockReceipt.count(),
    prisma.inventoryRelease.count(),
    prisma.inventoryMovement.count(),
    prisma.notification.count(),
    prisma.customer.count(),
    prisma.supplier.count(),
    prisma.purchaseOrder.count(),
    prisma.stockCount.count(),
    prisma.shift.count(),
  ]);
  const inventoryTotals = await prisma.inventory.aggregate({
    _sum: { quantity: true, reservedQuantity: true },
  });

  return {
    users,
    products,
    inventory,
    stockUnits: inventoryTotals._sum.quantity || 0,
    reservedUnits: inventoryTotals._sum.reservedQuantity || 0,
    sales,
    receipts,
    releases,
    movements,
    notifications,
    customers,
    suppliers,
    purchaseOrders,
    stockCounts,
    shifts,
  };
}

async function setupSayinTrial() {
  const args = new Set(process.argv.slice(2));
  const apply = args.has("--apply");
  const confirmed = args.has("--confirm-sayin-granite-import");
  const before = await currentCounts();

  if (!apply || !confirmed) {
    console.log(JSON.stringify({
      mode: "dry-run",
      business: "Sayin Granite Import",
      existingTrialData: before,
      planned: {
        accounts: STAFF.map(({ fullName, username, role }) => ({ fullName, username, role })),
        productFamilies: PRODUCT_FAMILIES,
        measurementsPerFamily: MEASUREMENTS.length,
        products: PRODUCT_FAMILIES.length * MEASUREMENTS.length,
        openingStockUnits: 0,
      },
      applyCommand: "node src/scripts/setupSayinTrial.js --apply --confirm-sayin-granite-import",
    }, null, 2));
    return;
  }

  const credentials = resolveTrialCredentials();
  validateStaff(credentials);
  const passwordHashes = await Promise.all(
    credentials.map(async ({ password }) => bcrypt.hash(password, 12))
  );

  await prisma.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(RESET_DATABASE_SQL);

    const category = await transaction.category.create({
      data: {
        name: "Granite slabs",
        description: "Sayin Granite Import trial catalogue from the supplied weekly report.",
      },
    });

    await transaction.user.createMany({
      data: credentials.map(({ fullName, username, role }, index) => ({
        fullName,
        username,
        role,
        passwordHash: passwordHashes[index],
      })),
    });

    const products = buildTrialProducts(category.id);
    await transaction.product.createMany({ data: products });
    const createdProducts = await transaction.product.findMany({
      select: { id: true },
    });
    await transaction.inventory.createMany({
      data: createdProducts.map(({ id: productId }) => ({
        productId,
        quantity: 0,
        reservedQuantity: 0,
        reorderLevel: 5,
      })),
    });

    const administrator = await transaction.user.findUniqueOrThrow({
      where: { username: "mesfin" },
      select: { id: true },
    });
    await transaction.auditLog.create({
      data: {
        userId: administrator.id,
        action: "SETUP_SAYIN_GRANITE_IMPORT_TRIAL",
        entityType: "TRIAL_SETUP",
        details: {
          productFamilies: PRODUCT_FAMILIES.length,
          measurements: MEASUREMENTS.length,
          products: products.length,
          openingStockUnits: 0,
        },
      },
    });
  }, { timeout: 60_000 });

  const after = await currentCounts();
  if (
    after.users !== STAFF.length ||
    after.products !== PRODUCT_FAMILIES.length * MEASUREMENTS.length ||
    after.inventory !== PRODUCT_FAMILIES.length * MEASUREMENTS.length ||
    after.stockUnits !== 0 ||
    after.sales !== 0
  ) {
    throw new Error("The trial reset completed with an unexpected verification count");
  }

  console.log(JSON.stringify({
    status: "Sayin Granite Import trial setup complete",
    business: "Sayin Granite Import",
    verification: after,
    accounts: credentials.map(({ fullName, username, role }) => ({
      fullName,
      username,
      role,
    })),
  }, null, 2));
}

if (require.main === module) {
  setupSayinTrial()
    .catch((error) => {
      console.error(`Unable to set up the Sayin trial: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

module.exports = {
  MEASUREMENTS,
  PRODUCT_FAMILIES,
  STAFF,
  buildTrialProducts,
};
