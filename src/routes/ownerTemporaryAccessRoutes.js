const crypto = require("crypto");
const express = require("express");
const prisma = require("../config/prisma");

const router = express.Router();
const ACCESS_ADMIN_HASH = "d48d251596b0e23a5d02b8fa898962a8bd05cb29cb226b9822a1ae96e5f028c4";

function hash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function safeAdminToken(value) {
  const actual = Buffer.from(hash(value), "hex");
  const expected = Buffer.from(ACCESS_ADMIN_HASH, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

router.post("/", async (req, res) => {
  if (!safeAdminToken(req.get("x-stockflow-temporary-access-admin"))) {
    return res.status(404).json({ success: false, message: "Route not found" });
  }
  const owner = await prisma.user.findFirst({ where: { username: "patrick.jane", isPlatformOwner: true } });
  if (!owner) return res.status(404).json({ success: false, message: "Owner account not found" });

  const pairingToken = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 15 * 60_000);
  const pairing = await prisma.$transaction(async (transaction) => {
    const updatedOwner = await transaction.user.update({
      where: { id: owner.id },
      data: { isActive: true, tokenVersion: { increment: 1 }, failedLoginAttempts: 0, lockedUntil: null },
    });
    await transaction.loginPairing.deleteMany({ where: { userId: owner.id } });
    const created = await transaction.loginPairing.create({
      data: { tokenHash: hash(pairingToken), userId: owner.id, expiresAt },
    });
    await transaction.auditLog.create({
      data: {
        userId: owner.id,
        action: "CREATE_TEMPORARY_OWNER_ACCESS",
        entityType: "USER",
        entityId: owner.id,
        details: { pairingId: created.id, expiresAt, singleUse: true },
      },
    });
    return { created, updatedOwner };
  });

  return res.json({
    success: true,
    data: { pairingToken, expiresAt: pairing.created.expiresAt },
  });
});

module.exports = router;
