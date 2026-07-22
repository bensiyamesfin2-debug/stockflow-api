const express = require("express");
const {
  getDashboard,
  getSalesReport,
  getPaymentReport,
} = require("../controllers/reportController");
const { authenticate, authorizeRoles } = require("../middleware/auth");

const router = express.Router();

router.get("/dashboard", authenticate, getDashboard);
router.get("/sales", authenticate, authorizeRoles("ADMIN"), getSalesReport);
router.get(
  "/payments",
  authenticate,
  authorizeRoles("ADMIN"),
  getPaymentReport
);

module.exports = router;
