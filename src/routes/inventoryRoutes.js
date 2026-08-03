const express = require("express");
const {
  listInventory,
  createStockReceipt,
  listStockReceipts,
  listInventoryMovements,
  listLocations,
  createLocation,
  updateLocation,
  listBatches,
  adjustInventory,
  listAuditLogs,
} = require("../controllers/inventoryController");
const { authenticate, authorizeRoles } = require("../middleware/auth");

const router = express.Router();

router.use(authenticate);
router.get("/", listInventory);
router.get("/locations", authorizeRoles("ADMIN", "INVENTORY_STAFF"), listLocations);
router.post("/locations", authorizeRoles("ADMIN"), createLocation);
router.patch("/locations/:id", authorizeRoles("ADMIN"), updateLocation);
router.get("/batches", authorizeRoles("ADMIN", "INVENTORY_STAFF"), listBatches);
router.post("/adjustments", authorizeRoles("ADMIN", "INVENTORY_STAFF"), adjustInventory);
router.get("/audit", authorizeRoles("ADMIN"), listAuditLogs);
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
