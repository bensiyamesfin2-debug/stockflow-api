const assert = require("node:assert/strict");
const test = require("node:test");
const {
  normalizeCustomMeasurement,
  calculateCustomOrder,
  planCustomCuts,
} = require("../src/utils/customOrder");

const STOCK_SLAB = { name: "Window Sill 603", length: 2000, width: 1000, thickness: 30 };

test("normalizeCustomMeasurement leaves cut* null when the cut size is not sent", () => {
  const errors = [];
  const measurement = normalizeCustomMeasurement(
    { length: 1200, width: 800, thickness: 20, pieces: 2 },
    1,
    errors
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(measurement, {
    length: 1200,
    width: 800,
    thickness: 20,
    pieces: 2,
    cutLength: null,
    cutWidth: null,
    cutThickness: null,
  });
});

test("normalizeCustomMeasurement accepts a cut size that differs from the order", () => {
  const errors = [];
  const measurement = normalizeCustomMeasurement(
    { length: 1200, width: 800, thickness: 20, pieces: 2, cutLength: 1250, cutWidth: 850, cutThickness: 20 },
    1,
    errors
  );
  assert.deepEqual(errors, []);
  assert.equal(measurement.cutLength, 1250);
  assert.equal(measurement.cutWidth, 850);
  assert.equal(measurement.cutThickness, 20);
});

test("normalizeCustomMeasurement rejects a partial cut size", () => {
  const errors = [];
  const measurement = normalizeCustomMeasurement(
    { length: 1200, width: 800, thickness: 20, pieces: 2, cutLength: 1250 },
    1,
    errors
  );
  assert.equal(measurement, null);
  assert.ok(errors.some((message) => /cut length, width, and thickness together/i.test(message)));
});

test("normalizeCustomMeasurement rejects a non-numeric cut size", () => {
  const errors = [];
  const measurement = normalizeCustomMeasurement(
    { length: 1200, width: 800, thickness: 20, pieces: 2, cutLength: "wide", cutWidth: 850, cutThickness: 20 },
    1,
    errors
  );
  assert.equal(measurement, null);
  assert.ok(errors.some((message) => /cut length, width, and thickness must be positive whole numbers/i.test(message)));
});

test("calculateCustomOrder fits pieces using the ordered size when no cut size is recorded", () => {
  const { piecesPerStockUnit } = calculateCustomOrder(STOCK_SLAB, {
    length: 1000, width: 500, thickness: 20, pieces: 1, cutLength: null, cutWidth: null, cutThickness: null,
  });
  assert.equal(piecesPerStockUnit, 4);
});

test("calculateCustomOrder fits pieces using the recorded cut size, not the order", () => {
  const { piecesPerStockUnit } = calculateCustomOrder(STOCK_SLAB, {
    length: 1000, width: 500, thickness: 20, pieces: 1, cutLength: 2000, cutWidth: 1000, cutThickness: 20,
  });
  assert.equal(piecesPerStockUnit, 1);
});

test("calculateCustomOrder checks the cut thickness against the stock, not the ordered thickness", () => {
  assert.throws(
    () => calculateCustomOrder(STOCK_SLAB, {
      length: 1000, width: 500, thickness: 20, pieces: 1, cutLength: 1000, cutWidth: 500, cutThickness: 40,
    }),
    /Cut thickness 40 cannot be cut from 30 thickness stock/
  );
});

test("planCustomCuts bins pieces by their cut size when one order records a different cut", () => {
  const plan = planCustomCuts(STOCK_SLAB, [
    { length: 1900, width: 950, thickness: 20, pieces: 1, cutLength: null, cutWidth: null, cutThickness: null },
    { length: 1900, width: 950, thickness: 20, pieces: 1, cutLength: 900, cutWidth: 900, cutThickness: 20 },
  ]);
  // The first selection (uncut, 1900x950) fills its own slab; the smaller
  // recorded cut (900x900) fits in the offcut of a fresh slab of its own
  // rather than forcing a third slab.
  assert.equal(plan.quantity, 2);
  assert.deepEqual(plan.allocations, [1, 1]);
});
