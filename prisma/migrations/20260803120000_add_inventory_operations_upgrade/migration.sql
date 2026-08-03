ALTER TABLE "sales"
  ADD COLUMN "credit_balance" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN "credit_due_at" TIMESTAMPTZ(3);

ALTER TABLE "stock_receipts"
  ADD COLUMN "container_number" VARCHAR(100),
  ADD COLUMN "vehicle_plate" VARCHAR(80),
  ADD COLUMN "quality_status" VARCHAR(40),
  ADD COLUMN "inspection_notes" TEXT;

ALTER TABLE "stock_receipt_items"
  ADD COLUMN "damaged_quantity" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "batch_id" INTEGER;

CREATE TABLE "inventory_locations" (
  "id" SERIAL NOT NULL,
  "code" VARCHAR(80) NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "warehouse" VARCHAR(120),
  "row_label" VARCHAR(60),
  "rack" VARCHAR(60),
  "slot" VARCHAR(60),
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "inventory_locations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inventory_locations_code_key" ON "inventory_locations"("code");

CREATE TABLE "inventory_location_balances" (
  "id" SERIAL NOT NULL,
  "location_id" INTEGER NOT NULL,
  "product_id" INTEGER NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "inventory_location_balances_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inventory_location_balances_location_id_product_id_key" ON "inventory_location_balances"("location_id", "product_id");
CREATE INDEX "inventory_location_balances_product_id_idx" ON "inventory_location_balances"("product_id");

CREATE TABLE "stock_batches" (
  "id" SERIAL NOT NULL,
  "batch_number" VARCHAR(120) NOT NULL,
  "product_id" INTEGER NOT NULL,
  "receipt_id" INTEGER,
  "supplier_id" INTEGER,
  "location_id" INTEGER,
  "origin" VARCHAR(120),
  "color" VARCHAR(120),
  "grade" VARCHAR(80),
  "original_quantity" INTEGER NOT NULL,
  "available_quantity" INTEGER NOT NULL,
  "notes" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "stock_batches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stock_batches_batch_number_key" ON "stock_batches"("batch_number");
CREATE INDEX "stock_batches_product_id_available_quantity_idx" ON "stock_batches"("product_id", "available_quantity");
CREATE INDEX "stock_batches_location_id_idx" ON "stock_batches"("location_id");

CREATE UNIQUE INDEX "stock_receipt_items_batch_id_key" ON "stock_receipt_items"("batch_id");

CREATE TABLE "delivery_proofs" (
  "id" SERIAL NOT NULL,
  "release_id" INTEGER NOT NULL,
  "delivered_by_id" INTEGER NOT NULL,
  "receiver_name" VARCHAR(150) NOT NULL,
  "receiver_phone" VARCHAR(40),
  "signature_name" VARCHAR(150),
  "photo_name" VARCHAR(180),
  "photo_mime_type" VARCHAR(100),
  "photo_content" TEXT,
  "notes" TEXT,
  "delivered_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "delivery_proofs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "delivery_proofs_release_id_key" ON "delivery_proofs"("release_id");
CREATE INDEX "delivery_proofs_delivered_at_idx" ON "delivery_proofs"("delivered_at");

ALTER TABLE "inventory_location_balances"
  ADD CONSTRAINT "inventory_location_balances_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "inventory_location_balances_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "stock_batches"
  ADD CONSTRAINT "stock_batches_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_batches_receipt_id_fkey"
  FOREIGN KEY ("receipt_id") REFERENCES "stock_receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_batches_supplier_id_fkey"
  FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_batches_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "stock_receipt_items"
  ADD CONSTRAINT "stock_receipt_items_batch_id_fkey"
  FOREIGN KEY ("batch_id") REFERENCES "stock_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "delivery_proofs"
  ADD CONSTRAINT "delivery_proofs_release_id_fkey"
  FOREIGN KEY ("release_id") REFERENCES "inventory_releases"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "delivery_proofs_delivered_by_id_fkey"
  FOREIGN KEY ("delivered_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
