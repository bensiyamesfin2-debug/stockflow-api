const express = require("express");
const {
  createProduct,
  listProducts,
  getProduct,
  updateProduct,
} = require("../controllers/productController");
const { authenticate, authorizeRoles } = require("../middleware/auth");

const router = express.Router();

router.use(authenticate);
router.get("/", listProducts);
router.get("/:id", getProduct);
router.post("/", authorizeRoles("ADMIN"), createProduct);
router.patch("/:id", authorizeRoles("ADMIN"), updateProduct);

module.exports = router;
