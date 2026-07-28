function buildSaleNotification({ saleNumber, customerName, items }) {
  const itemTypes = items.length;
  const stockUnits = items.reduce((total, item) => total + item.quantity, 0);

  return {
    type: "SALE_CREATED",
    title: "New sale awaiting release",
    message: [
      saleNumber,
      customerName || "Walk-in customer",
      `${itemTypes} item type${itemTypes === 1 ? "" : "s"}`,
      `${stockUnits} stock unit${stockUnits === 1 ? "" : "s"}`,
    ].join(" · "),
  };
}

module.exports = { buildSaleNotification };
