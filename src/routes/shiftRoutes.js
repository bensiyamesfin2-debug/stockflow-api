const express = require("express");
const {
  listShifts,
  openShift,
  closeShift,
} = require("../controllers/shiftController");
const { authenticate, authorizeRoles } = require("../middleware/auth");

const router = express.Router();
router.use(authenticate, authorizeRoles("ADMIN", "CASHIER"));
router.get("/", listShifts);
router.post("/", openShift);
router.post("/:id/close", closeShift);

module.exports = router;
