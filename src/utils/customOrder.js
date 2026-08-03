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

// Packs several requested rectangles into their common stock slab. This is a
// guillotine-cut plan: every placement leaves rectangular off-cuts that can be
// used by the next requested piece. It prevents complementary cuts in one sale
// from reserving the same stock slab twice.
function planCustomCuts(product, selections) {
  if (!Array.isArray(selections) || selections.length === 0) {
    return { quantity: 0, allocations: [], piecesPerStockUnit: [] };
  }

  const stockLength = positiveWholeNumber(product.length);
  const stockWidth = positiveWholeNumber(product.width);
  const stockThickness = positiveWholeNumber(product.thickness);
  if (!stockLength || !stockWidth || !stockThickness) {
    throw new HttpError(409, `${product.name} does not have a complete stock measurement`);
  }

  const allocations = Array(selections.length).fill(0);
  const piecesPerStockUnit = Array(selections.length).fill(0);
  const pieces = [];

  selections.forEach((selection, index) => {
    const measurement = selection.customMeasurement || selection;
    const checked = calculateCustomOrder(product, measurement);
    piecesPerStockUnit[index] = checked.piecesPerStockUnit;
    if (measurement.thickness > stockThickness) {
      throw new HttpError(409, `Custom thickness ${measurement.thickness} cannot be cut from ${stockThickness} thickness stock`);
    }
    if (pieces.length + measurement.pieces > 10_000) {
      throw new HttpError(400, "A shared custom-cut plan cannot exceed 10,000 pieces");
    }
    for (let piece = 0; piece < measurement.pieces; piece += 1) {
      pieces.push({ selectionIndex: index, length: measurement.length, width: measurement.width });
    }
  });

  pieces.sort((left, right) => (right.length * right.width) - (left.length * left.width));
  const bins = [];

  function findPlacement(bin, piece) {
    let best = null;
    bin.free.forEach((free, freeIndex) => {
      [[piece.length, piece.width], [piece.width, piece.length]].forEach(([length, width], orientation) => {
        if (length > free.length || width > free.width) return;
        const waste = free.length * free.width - length * width;
        const shortSide = Math.min(free.length - length, free.width - width);
        const candidate = { freeIndex, length, width, waste, shortSide, orientation };
        if (!best || candidate.waste < best.waste || (candidate.waste === best.waste && candidate.shortSide < best.shortSide)) best = candidate;
      });
    });
    return best;
  }

  for (const piece of pieces) {
    let chosenBin = null;
    let placement = null;
    for (const bin of bins) {
      const candidate = findPlacement(bin, piece);
      if (candidate && (!placement || candidate.waste < placement.waste || (candidate.waste === placement.waste && candidate.shortSide < placement.shortSide))) {
        chosenBin = bin;
        placement = candidate;
      }
    }
    if (!placement) {
      chosenBin = { owner: piece.selectionIndex, free: [{ length: stockLength, width: stockWidth }] };
      bins.push(chosenBin);
      placement = findPlacement(chosenBin, piece);
      allocations[piece.selectionIndex] += 1;
    }
    const free = chosenBin.free.splice(placement.freeIndex, 1)[0];
    const rightLength = free.length - placement.length;
    const bottomWidth = free.width - placement.width;
    if (rightLength > 0) chosenBin.free.push({ length: rightLength, width: free.width });
    if (bottomWidth > 0) chosenBin.free.push({ length: placement.length, width: bottomWidth });
  }

  return { quantity: bins.length, allocations, piecesPerStockUnit };
}

module.exports = {
  calculateCustomOrder,
  planCustomCuts,
  normalizeCustomMeasurement,
};
