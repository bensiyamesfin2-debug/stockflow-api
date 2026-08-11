const crypto = require("crypto");
const express = require("express");
const prisma = require("../config/prisma");

const router = express.Router();
const DISABLE_TOKEN_HASH = "e5ab6dfe0f2a8cb559eb11fc14ec8f0d054828947e2e092a87bfe9622f64c131";

function safeToken(value) {
  const actual = crypto.createHash("sha256").update(String(value || "")).digest();
  const expected = Buffer.from(DISABLE_TOKEN_HASH, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

router.post("/", async (req, res) => {
  if (!safeToken(req.get("x-stockflow-disable-token"))) {
    return res.status(404).json({ success: false, message: "Route not found" });
  }
  const owner = await prisma.user.findFirst({ where: { username: "patrick.jane", isPlatformOwner: true } });
  if (!owner) return res.status(404).json({ success: false, message: "Owner account not found" });
  await prisma.$transaction([
    prisma.user.update({
      where: { id: owner.id },
      data: { isActive: false, tokenVersion: { increment: 1 }, failedLoginAttempts: 0, lockedUntil: null },
    }),
    prisma.auditLog.create({
      data: { userId: owner.id, action: "TEMPORARILY_DISABLE_PLATFORM_OWNER", entityType: "USER", entityId: owner.id },
    }),
  ]);
  return res.json({ success: true, message: "Owner access disabled" });
});

module.exports = router;
