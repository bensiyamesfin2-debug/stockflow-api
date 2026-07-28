ALTER TABLE "sale_items"
  ADD COLUMN "custom_length" INTEGER,
  ADD COLUMN "custom_width" INTEGER,
  ADD COLUMN "custom_thickness" INTEGER,
  ADD COLUMN "requested_pieces" INTEGER,
  ADD COLUMN "pieces_per_stock_unit" INTEGER;

ALTER TABLE "sale_items"
  ADD CONSTRAINT "sale_items_custom_measurement_complete"
  CHECK (
    (
      "custom_length" IS NULL
      AND "custom_width" IS NULL
      AND "custom_thickness" IS NULL
      AND "requested_pieces" IS NULL
      AND "pieces_per_stock_unit" IS NULL
    )
    OR
    (
      "custom_length" > 0
      AND "custom_width" > 0
      AND "custom_thickness" > 0
      AND "requested_pieces" > 0
      AND "pieces_per_stock_unit" > 0
    )
  );
