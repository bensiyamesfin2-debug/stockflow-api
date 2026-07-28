const dashboardSaleInclude = {
  cashier: {
    select: { id: true, fullName: true, username: true },
  },
  items: {
    select: {
      id: true,
      quantity: true,
      releasedQuantity: true,
      customLength: true,
      customWidth: true,
      customThickness: true,
      requestedPieces: true,
      piecesPerStockUnit: true,
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
