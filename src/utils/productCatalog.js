const { createHash } = require("crypto");

const CORE_PRODUCT_FAMILIES = new Map([
  ["galaxy", "Galaxy"],
  ["640", "640"],
  ["markino", "Markino"],
  ["603", "603"],
  ["664", "664"],
  ["602", "602"],
  ["664 old", "664 Old"],
  ["black galaxy", "Black Galaxy"],
  ["river black", "River Black"],
  ["tiger skin", "Tiger Skin"],
]);

function normalizeProductName(value) {
  const normalized = String(value || "").trim().replace(/\s+/g, " ");
  const coreName = CORE_PRODUCT_FAMILIES.get(normalized.toLowerCase());

  if (coreName) return { name: coreName };
  if (normalized.length < 2 || normalized.length > 100) {
    return { error: "Product name must be between 2 and 100 characters" };
  }
  if (/[\u0000-\u001F\u007F]/.test(normalized)) {
    return { error: "Product name contains unsupported characters" };
  }

  return { name: normalized };
}

function makeInternalSku(name, length, width, thickness) {
  const family = name.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  const coreName = CORE_PRODUCT_FAMILIES.get(name.toLowerCase());

  if (coreName) {
    return `${family}-${length}-${width}-${thickness}`;
  }

  const fingerprint = createHash("sha256")
    .update(name.toLowerCase())
    .digest("hex")
    .slice(0, 8)
    .toUpperCase();

  return `${family || "PRODUCT"}-${fingerprint}-${length}-${width}-${thickness}`;
}

module.exports = {
  normalizeProductName,
  makeInternalSku,
};
