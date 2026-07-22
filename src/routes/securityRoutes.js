const express = require("express");
const {
  getSecurityStatus,
  createEncryptedBackup,
} = require("../controllers/securityController");
const { authenticate, authorizeRoles } = require("../middleware/auth");

const router = express.Router();

router.use(authenticate);
router.get("/status", getSecurityStatus);
router.post(
  "/backup",
  authorizeRoles("ADMIN"),
  createEncryptedBackup
);

module.exports = router;
