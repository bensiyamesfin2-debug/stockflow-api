const express = require("express");
const {
  login,
  getCurrentUser,
  getSetupStatus,
  initializeAdmin,
} = require("../controllers/authController");
const { authenticate } = require("../middleware/auth");

const router = express.Router();

router.post("/login", login);
router.get("/setup-status", getSetupStatus);
router.post("/setup", initializeAdmin);
router.get("/me", authenticate, getCurrentUser);

module.exports = router;
