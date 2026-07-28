const webPush = require("web-push");

let configuredSignature = "";

function getPushConfiguration() {
  const publicKey = String(process.env.VAPID_PUBLIC_KEY || "").trim();
  const privateKey = String(process.env.VAPID_PRIVATE_KEY || "").trim();
  const subject = String(
    process.env.VAPID_SUBJECT ||
      "https://stockflow-web-production-ab66.up.railway.app"
  ).trim();

  if (!publicKey || !privateKey || !subject) return null;

  const signature = `${subject}:${publicKey}:${privateKey}`;
  if (configuredSignature !== signature) {
    webPush.setVapidDetails(subject, publicKey, privateKey);
    configuredSignature = signature;
  }

  return { publicKey };
}

function normalizePushSubscription(body) {
  const endpoint = String(body?.endpoint || "").trim();
  const p256dh = String(body?.keys?.p256dh || "").trim();
  const auth = String(body?.keys?.auth || "").trim();
  const expirationValue = body?.expirationTime;

  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:") {
      return { error: "The notification subscription must use HTTPS" };
    }
  } catch {
    return { error: "The notification subscription endpoint is invalid" };
  }

  if (endpoint.length > 2_048) {
    return { error: "The notification subscription endpoint is too long" };
  }

  const base64Url = /^[A-Za-z0-9_-]+$/;
  if (!base64Url.test(p256dh) || p256dh.length < 40 || p256dh.length > 255) {
    return { error: "The notification encryption key is invalid" };
  }
  if (!base64Url.test(auth) || auth.length < 8 || auth.length > 255) {
    return { error: "The notification authentication key is invalid" };
  }

  let expirationTime = null;
  if (expirationValue !== null && expirationValue !== undefined) {
    const numericExpiration = Number(expirationValue);
    if (!Number.isSafeInteger(numericExpiration) || numericExpiration <= 0) {
      return { error: "The notification expiration time is invalid" };
    }
    expirationTime = BigInt(numericExpiration);
  }

  return { endpoint, p256dh, auth, expirationTime };
}

async function sendNewSalePushNotification({ saleId, title, message }) {
  if (!getPushConfiguration()) {
    return { sent: 0, expired: 0, unavailable: true };
  }

  const prisma = require("../config/prisma");
  const subscriptions = await prisma.pushSubscription.findMany({
    where: {
      user: {
        role: "INVENTORY_STAFF",
        isActive: true,
      },
    },
    select: {
      id: true,
      endpoint: true,
      p256dh: true,
      auth: true,
    },
  });
  const payload = JSON.stringify({
    title,
    body: message,
    icon: "/icon-192.png",
    badge: "/favicon-32.png",
    tag: `stockflow-sale-${saleId}`,
    data: { url: "/?view=notifications" },
  });
  const expiredIds = [];
  let sent = 0;

  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webPush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: {
              p256dh: subscription.p256dh,
              auth: subscription.auth,
            },
          },
          payload,
          {
            TTL: 24 * 60 * 60,
            urgency: "high",
            topic: `sale-${saleId}`,
          }
        );
        sent += 1;
      } catch (error) {
        if ([404, 410].includes(error.statusCode)) {
          expiredIds.push(subscription.id);
          return;
        }
        console.error("Unable to deliver a sale push notification:", error.message);
      }
    })
  );

  if (expiredIds.length) {
    await prisma.pushSubscription.deleteMany({
      where: { id: { in: expiredIds } },
    });
  }

  return { sent, expired: expiredIds.length, unavailable: false };
}

module.exports = {
  getPushConfiguration,
  normalizePushSubscription,
  sendNewSalePushNotification,
};
