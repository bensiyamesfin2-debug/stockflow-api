const express = require("express");
const {
  getDashboard,
  getLiveSalesSummary,
  getSalesReport,
  getPaymentReport,
  getProfitReport,
  getLowStockAlerts,
  getTopSellingReport,
  getDeadStockReport,
  getProfitLossReport,
  getValuationReport,
} = require("../controllers/reportController");
const { authenticate, authorizeRoles } = require("../middleware/auth");

const router = express.Router();

router.get("/dashboard", authenticate, getDashboard);
router.get("/sales-summary", authenticate, authorizeRoles("ADMIN", "CASHIER"), getLiveSalesSummary);
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
router.get("/top-selling", authenticate, authorizeRoles("ADMIN"), getTopSellingReport);
router.get("/dead-stock", authenticate, authorizeRoles("ADMIN"), getDeadStockReport);
router.get("/profit-loss", authenticate, authorizeRoles("ADMIN"), getProfitLossReport);
router.get("/valuation", authenticate, authorizeRoles("ADMIN"), getValuationReport);

module.exports = router;
