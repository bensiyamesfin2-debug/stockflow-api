const express = require("express");
const { sendSaleWhatsApp } = require("../controllers/whatsappController");
const { authenticate, authorizeRoles } = require("../middleware/auth");

const router = express.Router();
router.use(authenticate, authorizeRoles("ADMIN", "CASHIER"));
router.post("/sales/:id", sendSaleWhatsApp);

module.exports = router;
