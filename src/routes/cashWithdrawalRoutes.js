const express = require("express");
const { listCashWithdrawals, createCashWithdrawal } = require("../controllers/cashWithdrawalController");
const { authenticate, authorizeRoles } = require("../middleware/auth");

const router = express.Router();
router.use(authenticate, authorizeRoles("ADMIN"));
router.get("/", listCashWithdrawals);
router.post("/", createCashWithdrawal);

module.exports = router;
