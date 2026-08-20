const express = require("express");
const {
  createSale,
  updateSale,
  recordCreditPayment,
  listSales,
  getSale,
  cancelSale,
  returnSale,
  previewSalesImport,
  importSales,
  downloadSalesImportTemplate,
} = require("../controllers/saleController");
const { authenticate, authorizeRoles } = require("../middleware/auth");

const router = express.Router();

router.use(authenticate);
router.get("/", authorizeRoles("ADMIN", "CASHIER"), listSales);
router.get("/import/template", authorizeRoles("ADMIN", "CASHIER"), downloadSalesImportTemplate);
router.post("/import/preview", authorizeRoles("ADMIN", "CASHIER"), express.raw({ type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", limit: "8mb" }), previewSalesImport);
router.post("/import", authorizeRoles("ADMIN", "CASHIER"), express.raw({ type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", limit: "8mb" }), importSales);
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
