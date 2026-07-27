function severityRank(severity) {
  return { OUT_OF_STOCK: 0, CRITICAL: 1, LOW: 2 }[severity] ?? 3;
}

function buildLowStockAlerts(inventoryRecords) {
  return inventoryRecords
    .filter((record) => {
      const available = record.quantity - record.reservedQuantity;
      return record.product.isActive && available <= record.reorderLevel;
    })
    .map((record) => {
      const availableQuantity = record.quantity - record.reservedQuantity;
      const criticalThreshold = Math.max(1, Math.floor(record.reorderLevel / 2));
      const severity =
        availableQuantity <= 0
          ? "OUT_OF_STOCK"
          : availableQuantity <= criticalThreshold
            ? "CRITICAL"
            : "LOW";
      const targetQuantity = Math.max(record.reorderLevel * 2, record.reorderLevel + 1);

      return {
        productId: record.productId,
        sku: record.product.sku,
        name: record.product.name,
        length: record.product.length,
        width: record.product.width,
        thickness: record.product.thickness,
        physicalQuantity: record.quantity,
        reservedQuantity: record.reservedQuantity,
        availableQuantity,
        reorderLevel: record.reorderLevel,
        severity,
        suggestedOrderQuantity: Math.max(1, targetQuantity - availableQuantity),
      };
    })
    .sort(
      (left, right) =>
        severityRank(left.severity) - severityRank(right.severity) ||
        left.availableQuantity - right.availableQuantity ||
        left.name.localeCompare(right.name)
    );
}

module.exports = { buildLowStockAlerts };
