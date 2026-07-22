const express = require("express");
const {
  listInventory,
  createStockReceipt,
  listStockReceipts,
  listInventoryMovements,
} = require("../controllers/inventoryController");
const { authenticate, authorizeRoles } = require("../middleware/auth");

const router = express.Router();

router.use(authenticate);
router.get("/", listInventory);
router.get(
  "/receipts",
  authorizeRoles("ADMIN", "INVENTORY_STAFF"),
  listStockReceipts
);
router.post(
  "/receipts",
  authorizeRoles("ADMIN", "INVENTORY_STAFF"),
  createStockReceipt
);
router.get(
  "/movements",
  authorizeRoles("ADMIN", "INVENTORY_STAFF"),
  listInventoryMovements
);

module.exports = router;
