const express = require("express");
const { listOwnerExpenseEntries, createOwnerExpenseEntry } = require("../controllers/ownerExpenseController");
const { authenticate, authorizeRoles } = require("../middleware/auth");

const router = express.Router();
router.use(authenticate, authorizeRoles("ADMIN", "CASHIER"));
router.get("/", listOwnerExpenseEntries);
router.post("/", createOwnerExpenseEntry);

module.exports = router;
