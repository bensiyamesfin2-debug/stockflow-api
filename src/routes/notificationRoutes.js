const express = require("express");
const {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  getPushConfig,
  subscribeToPush,
  unsubscribeFromPush,
} = require("../controllers/notificationController");
const { authenticate, authorizeRoles } = require("../middleware/auth");

const router = express.Router();

router.use(authenticate, authorizeRoles("INVENTORY_STAFF"));
router.get("/", listNotifications);
router.get("/push/config", getPushConfig);
router.post("/push/subscribe", subscribeToPush);
router.delete("/push/subscribe", unsubscribeFromPush);
router.post("/read-all", markAllNotificationsRead);
router.patch("/:id/read", markNotificationRead);

module.exports = router;
