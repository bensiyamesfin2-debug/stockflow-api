const HttpError = require("./HttpError");

function positiveWholeNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeCustomMeasurement(value, itemNumber, errors) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    errors.push(`Sale item ${itemNumber} custom measurement is invalid`);
    return null;
  }

  const length = positiveWholeNumber(value.length);
  const width = positiveWholeNumber(value.width);
  const thickness = positiveWholeNumber(value.thickness);
  const pieces = positiveWholeNumber(value.pieces);

  if (!length || !width || !thickness || !pieces) {
    errors.push(
      `Sale item ${itemNumber} custom length, width, thickness, and pieces must be positive whole numbers`
    );
    return null;
  }

  if (length > 10_000 || width > 10_000 || thickness > 1_000 || pieces > 100_000) {
    errors.push(`Sale item ${itemNumber} custom measurement is too large`);
    return null;
  }

  return { length, width, thickness, pieces };
}

function calculateCustomOrder(product, measurement) {
  const stockLength = positiveWholeNumber(product.length);
  const stockWidth = positiveWholeNumber(product.width);
  const stockThickness = positiveWholeNumber(product.thickness);

  if (!stockLength || !stockWidth || !stockThickness) {
    throw new HttpError(
      409,
      `${product.name} does not have a complete stock measurement`
    );
  }

  if (measurement.thickness > stockThickness) {
    throw new HttpError(
      409,
      `Custom thickness ${measurement.thickness} cannot be cut from ${stockThickness} thickness stock`
    );
  }

  const normalFit =
    Math.floor(stockLength / measurement.length) *
    Math.floor(stockWidth / measurement.width);
  const rotatedFit =
    Math.floor(stockLength / measurement.width) *
    Math.floor(stockWidth / measurement.length);
  const piecesPerStockUnit = Math.max(normalFit, rotatedFit);

  if (piecesPerStockUnit < 1) {
    throw new HttpError(
      409,
      `The custom ${measurement.length} × ${measurement.width} measurement does not fit the selected ${stockLength} × ${stockWidth} stock`
    );
  }

  return {
    quantity: Math.ceil(measurement.pieces / piecesPerStockUnit),
    piecesPerStockUnit,
  };
}

module.exports = {
  calculateCustomOrder,
  normalizeCustomMeasurement,
};
