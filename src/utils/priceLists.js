const { moneyToCents } = require("./money");
const { sellableUnitPriceCents } = require("./salePricing");

async function resolveCustomerPriceList(transaction, customer) {
  const requestedId = customer?.priceListId || null;
  const priceList = requestedId
    ? await transaction.priceList.findFirst({
        where: { id: requestedId, isActive: true },
        include: { items: true },
      })
    : await transaction.priceList.findFirst({
        where: { isActive: true, isDefault: true },
        include: { items: true },
        orderBy: { updatedAt: "desc" },
      });

  if (!priceList) return { priceList: null, pricesByProduct: new Map() };
  return {
    priceList,
    pricesByProduct: new Map(
      priceList.items.map((item) => [
        item.productId,
        moneyToCents(item.price.toFixed(2)),
      ])
    ),
  };
}

function saleUnitPriceCents(product, pricesByProduct) {
  return pricesByProduct.get(product.id) ?? sellableUnitPriceCents(product);
}

module.exports = { resolveCustomerPriceList, saleUnitPriceCents };
