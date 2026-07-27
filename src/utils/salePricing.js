const HttpError = require("./HttpError");
const { moneyToCents } = require("./money");

function sellableUnitPriceCents(product) {
  const unitPriceCents = moneyToCents(product.sellingPrice.toFixed(2));

  if (unitPriceCents === null || unitPriceCents <= 0n) {
    throw new HttpError(
      409,
      `Set a selling price for ${product.name} before recording a sale`
    );
  }

  return unitPriceCents;
}

module.exports = { sellableUnitPriceCents };
