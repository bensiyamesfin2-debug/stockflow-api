const HttpError = require("./HttpError");
const { moneyToCents } = require("./money");

function discountValueToCents(value) {
  return moneyToCents(typeof value?.toFixed === "function" ? value.toFixed(2) : value);
}

function assertDiscountAvailable(discount, subtotalCents, now = new Date()) {
  if (!discount || !discount.isActive) throw new HttpError(409, "Discount is inactive or unavailable");
  if (discount.startsAt && discount.startsAt > now) throw new HttpError(409, "Discount has not started yet");
  if (discount.endsAt && discount.endsAt < now) throw new HttpError(409, "Discount has expired");
  if (discount.usageLimit !== null && discount.usageCount >= discount.usageLimit) {
    throw new HttpError(409, "Discount usage limit has been reached");
  }
  if (discount.minimumAmount !== null) {
    const minimumCents = discountValueToCents(discount.minimumAmount);
    if (subtotalCents < minimumCents) throw new HttpError(409, "Sale does not meet the discount minimum");
  }
}

function calculateDiscountCents(discount, subtotalCents, now = new Date()) {
  assertDiscountAvailable(discount, subtotalCents, now);
  const valueCents = discountValueToCents(discount.value);
  let discountCents = discount.type === "PERCENTAGE"
    ? (subtotalCents * valueCents) / 10_000n
    : valueCents;
  if (discount.maximumDiscount !== null) {
    const capCents = discountValueToCents(discount.maximumDiscount);
    if (discountCents > capCents) discountCents = capCents;
  }
  if (discountCents > subtotalCents) discountCents = subtotalCents;
  return discountCents;
}

module.exports = {
  calculateDiscountCents,
  assertDiscountAvailable,
};
