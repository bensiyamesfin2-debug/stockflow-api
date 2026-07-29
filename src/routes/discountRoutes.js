const express = require("express");
const {
  listDiscounts,
  createDiscount,
  updateDiscount,
  applyDiscount,
} = require("../controllers/discountController");
const { authenticate, authorizeRoles } = require("../middleware/auth");

const router = express.Router();
router.use(authenticate, authorizeRoles("ADMIN", "CASHIER"));
router.get("/", listDiscounts);
router.post("/", authorizeRoles("ADMIN"), createDiscount);
router.patch("/:id", authorizeRoles("ADMIN"), updateDiscount);
router.post("/:id/apply", applyDiscount);

module.exports = router;
