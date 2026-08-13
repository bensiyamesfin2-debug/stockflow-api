const DEFAULT_MONTHLY_PRICE_MINOR = 1_000_000;

function addCalendarMonth(value) {
  const source = new Date(value);
  const year = source.getUTCFullYear();
  const month = source.getUTCMonth();
  const day = source.getUTCDate();
  const lastDay = new Date(Date.UTC(year, month + 2, 0)).getUTCDate();
  const next = new Date(source);
  next.setUTCDate(1);
  next.setUTCMonth(month + 1);
  next.setUTCDate(Math.min(day, lastDay));
  return next;
}

function subscriptionState(tenant, now = new Date()) {
  if (tenant.subscriptionExempt) return { code: "EXEMPT", allowed: true, daysRemaining: null };
  const endsAt = tenant.subscriptionEndsAt ? new Date(tenant.subscriptionEndsAt) : null;
  if (!endsAt) return { code: "DUE", allowed: false, daysRemaining: 0 };
  const remainingMs = endsAt.getTime() - new Date(now).getTime();
  if (remainingMs <= 0) return { code: "PAST_DUE", allowed: false, daysRemaining: 0 };
  return { code: "ACTIVE", allowed: tenant.status === "ACTIVE", daysRemaining: Math.ceil(remainingMs / 86_400_000) };
}

function subscriptionAccess(tenant, now = new Date()) {
  const state = subscriptionState(tenant, now);
  return {
    allowed: state.allowed,
    status: state.code,
    companyName: tenant.companyName,
    subscriptionEndsAt: tenant.subscriptionEndsAt || null,
    message: state.allowed ? "Subscription active" : "This StockFlow subscription is paused. Contact Ben IT Solutions to renew access.",
  };
}

module.exports = { DEFAULT_MONTHLY_PRICE_MINOR, addCalendarMonth, subscriptionState, subscriptionAccess };
