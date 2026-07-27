const dashboardSaleInclude = {
  cashier: {
    select: { id: true, fullName: true, username: true },
  },
  items: {
    select: {
      id: true,
      quantity: true,
      releasedQuantity: true,
      product: {
        select: {
          id: true,
          sku: true,
          name: true,
          length: true,
          width: true,
          thickness: true,
        },
      },
    },
  },
};

module.exports = { dashboardSaleInclude };
