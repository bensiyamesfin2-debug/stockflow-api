ALTER TABLE "products"
  ADD COLUMN "length" INTEGER,
  ADD COLUMN "width" INTEGER,
  ADD COLUMN "thickness" INTEGER;

-- Keep historical sale and inventory references intact while removing every
-- legacy item from the sellable catalogue.
UPDATE "products"
SET "is_active" = FALSE,
    "updated_at" = CURRENT_TIMESTAMP;

WITH product_families("name", "slug") AS (
  VALUES
    ('Galaxy', 'GALAXY'),
    ('640', '640'),
    ('602', '602'),
    ('Markino', 'MARKINO')
),
measurements("length", "width", "thickness") AS (
  VALUES
    (220,34,3),(200,34,3),(180,34,3),(160,34,3),(150,34,3),
    (140,34,3),(130,34,3),(125,34,3),(120,34,3),(115,34,3),
    (220,30,3),(200,30,3),(180,30,3),(160,30,3),(150,30,3),
    (140,30,3),(125,30,3),
    (220,28,3),(200,28,3),(180,28,3),(160,28,3),(150,28,3),
    (140,28,3),(125,28,3),
    (220,25,3),(200,25,3),(180,25,3),(160,25,3),(150,25,3),
    (140,25,3),(125,25,3),
    (240,63,2),(220,63,2),
    (220,50,2),(200,50,2),(180,50,2),(160,50,2),(150,50,2),
    (140,50,2),(125,50,2),
    (220,40,2),(200,40,2),(180,40,2),(160,40,2),(150,40,2),
    (140,40,2),(125,40,2),
    (220,30,2),(200,30,2),(180,30,2),(160,30,2),(150,30,2),
    (125,30,2),
    (200,25,2),(180,25,2),(160,25,2),(150,25,2),(140,25,2),
    (125,25,2),
    (200,20,2),(180,20,2),(160,20,2),(150,20,2),(140,20,2),
    (125,20,2),
    (40,40,1)
)
INSERT INTO "products" (
  "sku",
  "name",
  "length",
  "width",
  "thickness",
  "description",
  "selling_price",
  "cost_price",
  "is_active",
  "created_at",
  "updated_at"
)
SELECT
  product_families."slug" || '-' ||
    measurements."length" || '-' ||
    measurements."width" || '-' ||
    measurements."thickness",
  product_families."name",
  measurements."length",
  measurements."width",
  measurements."thickness",
  'Measurement ' || measurements."length" || ' × ' ||
    measurements."width" || ' × ' || measurements."thickness",
  0.00,
  NULL,
  TRUE,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM product_families
CROSS JOIN measurements
ON CONFLICT ("sku") DO UPDATE SET
  "name" = EXCLUDED."name",
  "length" = EXCLUDED."length",
  "width" = EXCLUDED."width",
  "thickness" = EXCLUDED."thickness",
  "description" = EXCLUDED."description",
  "is_active" = TRUE,
  "updated_at" = CURRENT_TIMESTAMP;

INSERT INTO "inventory" (
  "product_id",
  "quantity",
  "reserved_quantity",
  "reorder_level",
  "updated_at"
)
SELECT "id", 0, 0, 5, CURRENT_TIMESTAMP
FROM "products"
WHERE "is_active" = TRUE
ON CONFLICT ("product_id") DO NOTHING;
