const { normalizeMoney } = require("./validation");

function moneyToCents(value) {
  const normalized = normalizeMoney(value);

  if (normalized === null) {
    return null;
  }

  const [whole, fraction = ""] = normalized.split(".");
  return BigInt(whole) * 100n + BigInt(`${fraction}00`.slice(0, 2));
}

function centsToMoney(cents) {
  const whole = cents / 100n;
  const fraction = String(cents % 100n).padStart(2, "0");
  return `${whole}.${fraction}`;
}

module.exports = {
  moneyToCents,
  centsToMoney,
};
