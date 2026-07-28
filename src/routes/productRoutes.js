const express = require("express");
const {
  createProduct,
  listProducts,
  getProduct,
  updateProduct,
  deleteProduct,
} = require("../controllers/productController");
const { authenticate, authorizeRoles } = require("../middleware/auth");

const router = express.Router();

router.use(authenticate);
router.get("/", listProducts);
router.get("/:id", getProduct);
router.post("/", authorizeRoles("ADMIN", "CASHIER", "INVENTORY_STAFF"), createProduct);
router.patch("/:id", authorizeRoles("ADMIN", "CASHIER"), updateProduct);
router.delete("/:id", authorizeRoles("ADMIN", "CASHIER"), deleteProduct);

module.exports = router;
