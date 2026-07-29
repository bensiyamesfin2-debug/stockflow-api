const express = require("express");
const {
  listPurchaseOrders,
  createPurchaseOrder,
  updatePurchaseOrder,
  receivePurchaseOrder,
  cancelPurchaseOrder,
} = require("../controllers/purchaseOrderController");
const { authenticate, authorizeRoles } = require("../middleware/auth");

const router = express.Router();
router.use(authenticate);
router.get("/", authorizeRoles("ADMIN", "INVENTORY_STAFF"), listPurchaseOrders);
router.post("/", authorizeRoles("ADMIN"), createPurchaseOrder);
router.patch("/:id", authorizeRoles("ADMIN"), updatePurchaseOrder);
router.post("/:id/receive", authorizeRoles("ADMIN", "INVENTORY_STAFF"), receivePurchaseOrder);
router.post("/:id/cancel", authorizeRoles("ADMIN"), cancelPurchaseOrder);

module.exports = router;
