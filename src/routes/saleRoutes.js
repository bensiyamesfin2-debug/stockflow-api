const express = require("express");
const {
  createSale,
  updateSale,
  recordCreditPayment,
  listSales,
  getSale,
  cancelSale,
  returnSale,
} = require("../controllers/saleController");
const {
  previewHistoricalSaleImport,
  importHistoricalSales,
  downloadHistoricalSaleImportTemplate,
} = require("../controllers/historicalSaleController");
const { authenticate, authorizeRoles } = require("../middleware/auth");

const router = express.Router();

router.use(authenticate);
router.get("/import-history/template", authorizeRoles("ADMIN"), downloadHistoricalSaleImportTemplate);
router.post("/import-history/preview", authorizeRoles("ADMIN"), express.raw({ type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", limit: "10mb" }), previewHistoricalSaleImport);
router.post("/import-history", authorizeRoles("ADMIN"), express.raw({ type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", limit: "10mb" }), importHistoricalSales);
router.get("/", authorizeRoles("ADMIN", "CASHIER"), listSales);
router.post("/", authorizeRoles("ADMIN", "CASHIER"), createSale);
router.patch("/:id", authorizeRoles("ADMIN", "CASHIER"), updateSale);
router.post("/:id/payments", authorizeRoles("ADMIN", "CASHIER"), recordCreditPayment);
router.post(
  "/:id/cancel",
  authorizeRoles("ADMIN", "CASHIER"),
  cancelSale
);
router.post("/:id/returns", authorizeRoles("ADMIN", "CASHIER"), returnSale);
router.get("/:id", authorizeRoles("ADMIN", "CASHIER"), getSale);

module.exports = router;
