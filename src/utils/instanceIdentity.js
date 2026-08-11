const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const REGION_PATTERN = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;
const PLANS = new Set(["STARTER", "GROWTH", "ENTERPRISE"]);

function text(value, fallback) {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function readInstanceIdentity(environment = process.env) {
  const companyCode = text(environment.INSTANCE_COMPANY_CODE, "bensiya-plc").toLowerCase();
  if (!SLUG_PATTERN.test(companyCode)) {
    throw new Error("INSTANCE_COMPANY_CODE must be a lowercase URL-safe company slug");
  }

  const primaryCurrency = text(environment.INSTANCE_PRIMARY_CURRENCY, "ETB").toUpperCase();
  if (!CURRENCY_PATTERN.test(primaryCurrency)) {
    throw new Error("INSTANCE_PRIMARY_CURRENCY must be a three-letter currency code");
  }

  const region = text(environment.INSTANCE_REGION, "africa-east1").toLowerCase();
  const plan = text(environment.INSTANCE_PLAN, "GROWTH").toUpperCase();
  if (!REGION_PATTERN.test(region) || !PLANS.has(plan)) {
    throw new Error("INSTANCE_REGION and INSTANCE_PLAN must use supported SaaS values");
  }

  const explicitControlPlane = String(environment.INSTANCE_CONTROL_PLANE || "").toLowerCase();
  const controlPlane = explicitControlPlane
    ? explicitControlPlane === "true"
    : companyCode === "bensiya-plc";

  return Object.freeze({
    tenantKey: text(environment.INSTANCE_TENANT_ID, companyCode),
    companyCode,
    companyName: text(environment.INSTANCE_COMPANY_NAME, companyCode === "bensiya-plc" ? "Bensiya PLC" : "StockFlow Customer"),
    primaryCurrency,
    locale: text(environment.INSTANCE_LOCALE, "en"),
    timezone: text(environment.INSTANCE_TIMEZONE, "Africa/Addis_Ababa"),
    region,
    plan,
    publicUrl: text(environment.INSTANCE_PUBLIC_URL, "") || null,
    controlPlane,
    dataIsolationMode: "DEDICATED_DATABASE",
  });
}

const instanceIdentity = readInstanceIdentity();

function publicInstanceIdentity(identity = instanceIdentity) {
  return {
    companyCode: identity.companyCode,
    companyName: identity.companyName,
    primaryCurrency: identity.primaryCurrency,
    locale: identity.locale,
    timezone: identity.timezone,
    region: identity.region,
    plan: identity.plan,
    controlPlane: identity.controlPlane,
    dataIsolationMode: identity.dataIsolationMode,
  };
}

module.exports = { instanceIdentity, publicInstanceIdentity, readInstanceIdentity, SLUG_PATTERN };
