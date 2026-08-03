require("dotenv").config();

const bcrypt = require("bcrypt");
const prisma = require("../config/prisma");
const { validatePassword } = require("../controllers/userController");

const fullName = String(process.env.BEN_IT_OWNER_FULL_NAME || "").trim();
const username = String(process.env.BEN_IT_OWNER_USERNAME || "").trim().toLowerCase();
const password = String(process.env.BEN_IT_OWNER_PASSWORD || "");
const USERNAME_PATTERN = /^[a-z0-9._-]{3,50}$/;

async function createPlatformOwner() {
  if (fullName.length < 2 || fullName.length > 150) {
    throw new Error("BEN_IT_OWNER_FULL_NAME must be between 2 and 150 characters");
  }
  if (!USERNAME_PATTERN.test(username)) {
    throw new Error("BEN_IT_OWNER_USERNAME must use 3-50 lowercase letters, numbers, dots, underscores, or hyphens");
  }
  const passwordError = validatePassword(password, username);
  if (passwordError) throw new Error(passwordError);

  const existing = await prisma.user.findUnique({ where: { username } });
  const passwordHash = await bcrypt.hash(password, 12);
  const owner = await prisma.$transaction(async (transaction) => {
    if (existing) {
      return transaction.user.update({
        where: { id: existing.id },
        data: {
          fullName,
          passwordHash,
          isActive: true,
          isPlatformOwner: true,
          tokenVersion: { increment: 1 },
        },
        select: { id: true, username: true },
      });
    }

    return transaction.user.create({
      data: {
        fullName,
        username,
        passwordHash,
        role: "ADMIN",
        isPlatformOwner: true,
      },
      select: { id: true, username: true },
    });
  });

  await prisma.auditLog.create({
    data: {
      userId: owner.id,
      action: "PROVISION_PLATFORM_OWNER",
      entityType: "USER",
      entityId: owner.id,
    },
  });

  console.log(`Private platform owner ${owner.username} is ready.`);
}

createPlatformOwner()
  .catch((error) => {
    console.error(`Unable to provision private platform owner: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
