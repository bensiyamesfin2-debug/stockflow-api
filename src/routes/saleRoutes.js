const express = require("express");
const {
  createSale,
  updateSale,
  listSales,
  getSale,
  cancelSale,
} = require("../controllers/saleController");
const { authenticate, authorizeRoles } = require("../middleware/auth");

const router = express.Router();

router.use(authenticate);
router.get("/", authorizeRoles("ADMIN", "CASHIER"), listSales);
router.post("/", authorizeRoles("ADMIN", "CASHIER"), createSale);
router.patch("/:id", authorizeRoles("ADMIN", "CASHIER"), updateSale);
router.post(
  "/:id/cancel",
  authorizeRoles("ADMIN", "CASHIER"),
  cancelSale
);
router.get("/:id", authorizeRoles("ADMIN", "CASHIER"), getSale);

module.exports = router;
