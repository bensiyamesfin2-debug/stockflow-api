const prisma = require("../config/prisma");
const {
  getPushConfiguration,
  normalizePushSubscription,
} = require("../utils/pushNotifications");

const notificationSelect = {
  id: true,
  type: true,
  title: true,
  message: true,
  readAt: true,
  createdAt: true,
  sale: {
    select: {
      id: true,
      saleNumber: true,
      status: true,
    },
  },
};

async function listNotifications(req, res) {
  const requestedLimit = Number(req.query.limit);
  const limit = Number.isInteger(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 50)
    : 30;

  const [notifications, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: req.user.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      select: notificationSelect,
    }),
    prisma.notification.count({
      where: { userId: req.user.id, readAt: null },
    }),
  ]);

  return res.json({
    success: true,
    data: { notifications, unreadCount },
  });
}

async function markNotificationRead(req, res) {
  const notificationId = Number(req.params.id);

  if (!Number.isInteger(notificationId) || notificationId <= 0) {
    return res.status(400).json({
      success: false,
      message: "Invalid notification ID",
    });
  }

  const result = await prisma.notification.updateMany({
    where: {
      id: notificationId,
      userId: req.user.id,
      readAt: null,
    },
    data: { readAt: new Date() },
  });

  if (result.count === 0) {
    const notification = await prisma.notification.findFirst({
      where: { id: notificationId, userId: req.user.id },
      select: { id: true },
    });

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: "Notification not found",
      });
    }
  }

  return res.json({
    success: true,
    message: "Notification marked as read",
  });
}

async function markAllNotificationsRead(req, res) {
  const result = await prisma.notification.updateMany({
    where: { userId: req.user.id, readAt: null },
    data: { readAt: new Date() },
  });

  return res.json({
    success: true,
    message: "All notifications marked as read",
    data: { updated: result.count },
  });
}

function getPushConfig(req, res) {
  const configuration = getPushConfiguration();

  return res.json({
    success: true,
    data: {
      available: Boolean(configuration),
      publicKey: configuration?.publicKey || null,
    },
  });
}

async function subscribeToPush(req, res) {
  const configuration = getPushConfiguration();
  if (!configuration) {
    return res.status(503).json({
      success: false,
      message: "Device notifications are not configured yet",
    });
  }

  const subscription = normalizePushSubscription(req.body);
  if (subscription.error) {
    return res.status(400).json({
      success: false,
      message: subscription.error,
    });
  }

  await prisma.pushSubscription.upsert({
    where: { endpoint: subscription.endpoint },
    update: {
      userId: req.user.id,
      p256dh: subscription.p256dh,
      auth: subscription.auth,
      expirationTime: subscription.expirationTime,
    },
    create: {
      userId: req.user.id,
      endpoint: subscription.endpoint,
      p256dh: subscription.p256dh,
      auth: subscription.auth,
      expirationTime: subscription.expirationTime,
    },
  });

  return res.status(201).json({
    success: true,
    message: "Device notifications enabled",
  });
}

async function unsubscribeFromPush(req, res) {
  const endpoint = String(req.body?.endpoint || "").trim();
  if (!endpoint) {
    return res.status(400).json({
      success: false,
      message: "The notification subscription endpoint is required",
    });
  }

  await prisma.pushSubscription.deleteMany({
    where: { endpoint, userId: req.user.id },
  });

  return res.json({
    success: true,
    message: "Device notifications disabled",
  });
}

module.exports = {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  getPushConfig,
  subscribeToPush,
  unsubscribeFromPush,
};
