const express = require("express");
const {
  getSecurityStatus,
  createEncryptedBackup,
  startTwoFactorSetup,
  verifyTwoFactorSetup,
  disableTwoFactor,
  getHandoverResetPreview,
  resetSalesAndInventory,
} = require("../controllers/securityController");
const { authenticate, authorizeRoles } = require("../middleware/auth");

const router = express.Router();

router.use(authenticate);
router.get("/status", getSecurityStatus);
router.post("/2fa/setup", startTwoFactorSetup);
router.post("/2fa/verify", verifyTwoFactorSetup);
router.post("/2fa/disable", disableTwoFactor);
router.post(
  "/backup",
  authorizeRoles("ADMIN"),
  createEncryptedBackup
);
router.get("/handover-reset", authorizeRoles("ADMIN"), getHandoverResetPreview);
router.post("/handover-reset", authorizeRoles("ADMIN"), resetSalesAndInventory);

module.exports = router;
