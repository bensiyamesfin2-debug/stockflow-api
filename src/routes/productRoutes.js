const express = require("express");
const {
  createProduct,
  listProducts,
  getProduct,
  updateProduct,
  deleteProduct,
  previewProductImport,
  importProducts,
  downloadProductImportTemplate,
} = require("../controllers/productController");
const { authenticate, authorizeRoles } = require("../middleware/auth");

const router = express.Router();

router.use(authenticate);
router.get("/", listProducts);
router.get("/import/template", authorizeRoles("ADMIN", "CASHIER"), downloadProductImportTemplate);
router.post("/import/preview", authorizeRoles("ADMIN", "CASHIER"), express.raw({ type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", limit: "5mb" }), previewProductImport);
router.post("/import", authorizeRoles("ADMIN", "CASHIER"), express.raw({ type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", limit: "5mb" }), importProducts);
router.get("/:id", getProduct);
router.post("/", authorizeRoles("ADMIN", "CASHIER", "INVENTORY_STAFF"), createProduct);
router.patch("/:id", authorizeRoles("ADMIN", "CASHIER"), updateProduct);
router.delete("/:id", authorizeRoles("ADMIN", "CASHIER"), deleteProduct);

module.exports = router;
