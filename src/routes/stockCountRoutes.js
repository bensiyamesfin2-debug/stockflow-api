const express = require("express");
const {
  listStockCounts,
  createStockCount,
  completeStockCount,
  adjustStockCount,
} = require("../controllers/stockCountController");
const { authenticate, authorizeRoles } = require("../middleware/auth");

const router = express.Router();
router.use(authenticate, authorizeRoles("ADMIN", "INVENTORY_STAFF"));
router.get("/", listStockCounts);
router.post("/", createStockCount);
router.post("/:id/complete", completeStockCount);
router.post("/:id/adjust", adjustStockCount);

module.exports = router;
