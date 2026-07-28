function serializePendingReleaseSale(sale) {
  const { totalAmount, clientRequestId, items, payments, ...releaseSale } = sale;
  void totalAmount;
  void clientRequestId;
  void payments;
  return {
    ...releaseSale,
    items: items.map((item) => {
      const { unitPrice, costPriceAtSale, ...releaseItem } = item;
      void unitPrice;
      void costPriceAtSale;
      return {
        ...releaseItem,
        remainingQuantity: item.quantity - item.releasedQuantity,
        physicalStock: item.product.inventory?.quantity || 0,
      };
    }),
  };
}

module.exports = { serializePendingReleaseSale };
