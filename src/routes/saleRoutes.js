const express = require("express");
const {
  createSale,
  listSales,
  getSale,
  cancelSale,
} = require("../controllers/saleController");
const { authenticate, authorizeRoles } = require("../middleware/auth");

const router = express.Router();

router.use(authenticate);
router.get("/", listSales);
router.post("/", authorizeRoles("ADMIN", "CASHIER"), createSale);
router.post(
  "/:id/cancel",
  authorizeRoles("ADMIN", "CASHIER"),
  cancelSale
);
router.get("/:id", getSale);

module.exports = router;
