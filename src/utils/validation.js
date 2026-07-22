const MONEY_PATTERN = /^\d{1,10}(\.\d{1,2})?$/;

function normalizeMoney(value) {
  const normalized = String(value ?? "").trim();
  return MONEY_PATTERN.test(normalized) ? normalized : null;
}

function normalizeOptionalText(value, maximumLength) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const normalized = String(value).trim();

  if (!normalized || normalized.length > maximumLength) {
    return null;
  }

  return normalized;
}

module.exports = {
  normalizeMoney,
  normalizeOptionalText,
};
