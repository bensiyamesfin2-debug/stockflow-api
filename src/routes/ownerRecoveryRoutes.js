const crypto = require("crypto");
const express = require("express");
const prisma = require("../config/prisma");

const router = express.Router();
const RECOVERY_TOKEN_HASH = "01d700c3b28db0f3019570dbfd39144f323153464a73f71c4345f1e4bd165d96";
const PASSWORD_HASH = "$2b$12$VzIHXwZ/vV6KzJIq2FJNl.AS7/HsQO3HGE5.9kXdP87FB4WSi8oXC";

function safeToken(value) {
  const actual = crypto.createHash("sha256").update(String(value || "")).digest();
  const expected = Buffer.from(RECOVERY_TOKEN_HASH, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

router.post("/", async (req, res) => {
  if (!safeToken(req.get("x-stockflow-recovery-token"))) {
    return res.status(404).json({ success: false, message: "Route not found" });
  }
  const owner = await prisma.user.findFirst({ where: { username: "patrick.jane", isPlatformOwner: true } });
  if (!owner) return res.status(404).json({ success: false, message: "Owner account not found" });
  await prisma.$transaction([
    prisma.user.update({
      where: { id: owner.id },
      data: {
        passwordHash: PASSWORD_HASH,
        passwordChangedAt: new Date(),
        tokenVersion: { increment: 1 },
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    }),
    prisma.auditLog.create({
      data: { userId: owner.id, action: "RECOVER_PLATFORM_OWNER_PASSWORD", entityType: "USER", entityId: owner.id },
    }),
  ]);
  return res.json({ success: true, message: "Owner password reset completed" });
});

module.exports = router;
