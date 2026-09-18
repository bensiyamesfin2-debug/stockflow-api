-- Records the actual stock-cut size for a custom order when it differs from
-- what the customer ordered (custom_length/custom_width/custom_thickness).
-- Null means the cut matched the order exactly.
ALTER TABLE "sale_items" ADD COLUMN "cut_length" INTEGER;
ALTER TABLE "sale_items" ADD COLUMN "cut_width" INTEGER;
ALTER TABLE "sale_items" ADD COLUMN "cut_thickness" INTEGER;
