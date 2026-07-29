const express = require("express");
const {
  listSuppliers,
  createSupplier,
  updateSupplier,
} = require("../controllers/supplierController");
const { authenticate, authorizeRoles } = require("../middleware/auth");

const router = express.Router();
router.use(authenticate, authorizeRoles("ADMIN", "INVENTORY_STAFF"));
router.get("/", listSuppliers);
router.post("/", authorizeRoles("ADMIN"), createSupplier);
router.patch("/:id", authorizeRoles("ADMIN"), updateSupplier);

module.exports = router;
