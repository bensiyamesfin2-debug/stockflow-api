-- Customer price lists, internal stock transfers, and measurement quotations.
CREATE TYPE "QuotationStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED');

ALTER TYPE "InventoryMovementType" ADD VALUE IF NOT EXISTS 'TRANSFER_OUT';
ALTER TYPE "InventoryMovementType" ADD VALUE IF NOT EXISTS 'TRANSFER_IN';
ALTER TYPE "SaleStatus" ADD VALUE IF NOT EXISTS 'PARTIALLY_RETURNED';
ALTER TYPE "SaleStatus" ADD VALUE IF NOT EXISTS 'RETURNED';

ALTER TABLE "sale_items" ADD COLUMN "returned_quantity" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "price_lists" (
  "id" SERIAL NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "description" TEXT,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "is_default" BOOLEAN NOT NULL DEFAULT false,
  "created_by_id" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "price_lists_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "price_lists_name_key" ON "price_lists"("name");

CREATE TABLE "price_list_items" (
  "id" SERIAL NOT NULL,
  "price_list_id" INTEGER NOT NULL,
  "product_id" INTEGER NOT NULL,
  "price" DECIMAL(12, 2) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "price_list_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "price_list_items_price_list_id_product_id_key" ON "price_list_items"("price_list_id", "product_id");
CREATE INDEX "price_list_items_product_id_idx" ON "price_list_items"("product_id");

ALTER TABLE "customers" ADD COLUMN "price_list_id" INTEGER;
ALTER TABLE "sales" ADD COLUMN "price_list_id" INTEGER;
CREATE INDEX "customers_price_list_id_idx" ON "customers"("price_list_id");

CREATE TABLE "stock_transfers" (
  "id" SERIAL NOT NULL,
  "transfer_number" VARCHAR(60) NOT NULL,
  "from_location_id" INTEGER NOT NULL,
  "to_location_id" INTEGER NOT NULL,
  "transferred_by_id" INTEGER NOT NULL,
  "notes" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stock_transfers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stock_transfers_transfer_number_key" ON "stock_transfers"("transfer_number");
CREATE INDEX "stock_transfers_from_location_id_created_at_idx" ON "stock_transfers"("from_location_id", "created_at");
CREATE INDEX "stock_transfers_to_location_id_created_at_idx" ON "stock_transfers"("to_location_id", "created_at");

CREATE TABLE "stock_transfer_items" (
  "id" SERIAL NOT NULL,
  "transfer_id" INTEGER NOT NULL,
  "product_id" INTEGER NOT NULL,
  "batch_id" INTEGER,
  "quantity" INTEGER NOT NULL,
  CONSTRAINT "stock_transfer_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "stock_transfer_items_product_id_idx" ON "stock_transfer_items"("product_id");
CREATE INDEX "stock_transfer_items_batch_id_idx" ON "stock_transfer_items"("batch_id");

CREATE TABLE "quotations" (
  "id" SERIAL NOT NULL,
  "quote_number" VARCHAR(60) NOT NULL,
  "customer_id" INTEGER,
  "customer_name" VARCHAR(150),
  "customer_phone" VARCHAR(40),
  "created_by_id" INTEGER NOT NULL,
  "status" "QuotationStatus" NOT NULL DEFAULT 'DRAFT',
  "valid_until" TIMESTAMPTZ(3),
  "notes" TEXT,
  "total_area_sqm" DECIMAL(14, 3) NOT NULL DEFAULT 0,
  "total_amount" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "quotations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "quotations_quote_number_key" ON "quotations"("quote_number");
CREATE INDEX "quotations_customer_id_created_at_idx" ON "quotations"("customer_id", "created_at");
CREATE INDEX "quotations_status_created_at_idx" ON "quotations"("status", "created_at");

CREATE TABLE "quotation_items" (
  "id" SERIAL NOT NULL,
  "quotation_id" INTEGER NOT NULL,
  "product_id" INTEGER NOT NULL,
  "description" VARCHAR(240),
  "length_cm" INTEGER NOT NULL,
  "width_cm" INTEGER NOT NULL,
  "thickness_cm" INTEGER,
  "quantity" INTEGER NOT NULL,
  "area_sqm" DECIMAL(14, 3) NOT NULL,
  "unit_price_per_sqm" DECIMAL(12, 2) NOT NULL,
  "line_total" DECIMAL(12, 2) NOT NULL,
  CONSTRAINT "quotation_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "quotation_items_quotation_id_idx" ON "quotation_items"("quotation_id");
CREATE INDEX "quotation_items_product_id_idx" ON "quotation_items"("product_id");

ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_price_list_id_fkey" FOREIGN KEY ("price_list_id") REFERENCES "price_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customers" ADD CONSTRAINT "customers_price_list_id_fkey" FOREIGN KEY ("price_list_id") REFERENCES "price_lists"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "sales" ADD CONSTRAINT "sales_price_list_id_fkey" FOREIGN KEY ("price_list_id") REFERENCES "price_lists"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_from_location_id_fkey" FOREIGN KEY ("from_location_id") REFERENCES "inventory_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_to_location_id_fkey" FOREIGN KEY ("to_location_id") REFERENCES "inventory_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_transferred_by_id_fkey" FOREIGN KEY ("transferred_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "stock_transfers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "stock_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "quotations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "sale_returns" (
  "id" SERIAL NOT NULL,
  "return_number" VARCHAR(60) NOT NULL,
  "sale_id" INTEGER NOT NULL,
  "processed_by_id" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "return_value" DECIMAL(12, 2) NOT NULL,
  "refund_amount" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "refund_method" "PaymentMethod",
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sale_returns_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sale_returns_return_number_key" ON "sale_returns"("return_number");
CREATE INDEX "sale_returns_sale_id_created_at_idx" ON "sale_returns"("sale_id", "created_at");

CREATE TABLE "sale_return_items" (
  "id" SERIAL NOT NULL,
  "return_id" INTEGER NOT NULL,
  "sale_item_id" INTEGER NOT NULL,
  "quantity" INTEGER NOT NULL,
  "restocked" BOOLEAN NOT NULL DEFAULT true,
  "location_id" INTEGER,
  CONSTRAINT "sale_return_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sale_return_items_sale_item_id_idx" ON "sale_return_items"("sale_item_id");
CREATE INDEX "sale_return_items_location_id_idx" ON "sale_return_items"("location_id");

ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_processed_by_id_fkey" FOREIGN KEY ("processed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sale_return_items" ADD CONSTRAINT "sale_return_items_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "sale_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sale_return_items" ADD CONSTRAINT "sale_return_items_sale_item_id_fkey" FOREIGN KEY ("sale_item_id") REFERENCES "sale_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sale_return_items" ADD CONSTRAINT "sale_return_items_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Invariants protect stock and money even if a future application bug reaches the database.
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_quantities_nonnegative" CHECK ("quantity" >= 0 AND "reserved_quantity" >= 0 AND "reserved_quantity" <= "quantity");
ALTER TABLE "inventory_location_balances" ADD CONSTRAINT "location_balance_nonnegative" CHECK ("quantity" >= 0);
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batch_quantities_valid" CHECK ("original_quantity" >= 0 AND "available_quantity" >= 0 AND "available_quantity" <= "original_quantity");
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_item_quantities_valid" CHECK ("quantity" > 0 AND "released_quantity" >= 0 AND "returned_quantity" >= 0 AND "returned_quantity" <= "released_quantity" AND "released_quantity" <= "quantity");
ALTER TABLE "payments" ADD CONSTRAINT "payment_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "sale_return_items" ADD CONSTRAINT "sale_return_item_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_item_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_measurements_positive" CHECK ("length_cm" > 0 AND "width_cm" > 0 AND "quantity" > 0 AND "area_sqm" > 0 AND "unit_price_per_sqm" >= 0 AND "line_total" >= 0);
