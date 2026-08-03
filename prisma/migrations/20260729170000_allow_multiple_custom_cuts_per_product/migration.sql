-- A single sale can contain several custom cuts from the same stock item.
-- Release records still target each sale item independently.
DROP INDEX IF EXISTS "sale_items_sale_id_product_id_key";

CREATE INDEX IF NOT EXISTS "sale_items_sale_id_product_id_idx"
ON "sale_items"("sale_id", "product_id");
