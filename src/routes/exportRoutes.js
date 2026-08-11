const express = require("express");
const {
  exportSales,
  exportInventory,
  exportProducts,
  exportProfessionalWorkbook,
} = require("../controllers/exportController");
const { authenticate, authorizeRoles } = require("../middleware/auth");

const router = express.Router();
router.use(authenticate, authorizeRoles("ADMIN"));
router.get("/sales", exportSales);
router.get("/inventory", exportInventory);
router.get("/products", exportProducts);
router.get("/professional-workbook", exportProfessionalWorkbook);

module.exports = router;
