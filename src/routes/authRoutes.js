const express = require("express");
const {
  login,
  getCurrentUser,
} = require("../controllers/authController");
const { authenticate } = require("../middleware/auth");

const router = express.Router();

router.post("/login", login);
router.get("/me", authenticate, getCurrentUser);

module.exports = router;
