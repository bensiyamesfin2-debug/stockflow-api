const express = require("express");
const {
  getDashboard,
  getSalesReport,
  getPaymentReport,
  getProfitReport,
  getLowStockAlerts,
} = require("../controllers/reportController");
const { authenticate, authorizeRoles } = require("../middleware/auth");

const router = express.Router();

router.get("/dashboard", authenticate, getDashboard);
router.get("/sales", authenticate, authorizeRoles("ADMIN"), getSalesReport);
router.get("/profit", authenticate, authorizeRoles("ADMIN"), getProfitReport);
router.get(
  "/low-stock",
  authenticate,
  authorizeRoles("ADMIN", "INVENTORY_STAFF"),
  getLowStockAlerts
);
router.get(
  "/payments",
  authenticate,
  authorizeRoles("ADMIN"),
  getPaymentReport
);

module.exports = router;
