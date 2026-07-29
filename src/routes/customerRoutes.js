const express = require("express");
const {
  listCustomers,
  createCustomer,
  updateCustomer,
} = require("../controllers/customerController");
const { authenticate, authorizeRoles } = require("../middleware/auth");

const router = express.Router();
router.use(authenticate, authorizeRoles("ADMIN", "CASHIER"));
router.get("/", listCustomers);
router.post("/", createCustomer);
router.patch("/:id", updateCustomer);

module.exports = router;
