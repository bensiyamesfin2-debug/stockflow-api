const express = require("express");
const {
  login,
  getCurrentUser,
  getSetupStatus,
  initializeAdmin,
  changePassword,
  createLoginPairing,
  exchangeLoginPairing,
  getLoginPairingStatus,
} = require("../controllers/authController");
const { authenticate } = require("../middleware/auth");
const { loginRateLimit } = require("../middleware/loginRateLimit");

const router = express.Router();

router.post("/login", loginRateLimit, login);
router.get("/setup-status", getSetupStatus);
router.post("/setup", initializeAdmin);
router.get("/me", authenticate, getCurrentUser);
router.post("/change-password", authenticate, changePassword);
router.post("/pairing", authenticate, createLoginPairing);
router.post("/pairing/exchange", loginRateLimit, exchangeLoginPairing);
router.get("/pairing/:id", authenticate, getLoginPairingStatus);

module.exports = router;
