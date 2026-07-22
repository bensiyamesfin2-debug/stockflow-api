-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('COMPLETED', 'VOIDED', 'REFUNDED');

-- AlterTable
ALTER TABLE "inventory" ADD COLUMN     "reserved_quantity" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "status" "PaymentStatus" NOT NULL DEFAULT 'COMPLETED';

-- AlterTable
ALTER TABLE "sale_items" ADD COLUMN     "cost_price_at_sale" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "cancellation_reason" TEXT,
ADD COLUMN     "cancelled_at" TIMESTAMPTZ(3),
ADD COLUMN     "completed_at" TIMESTAMPTZ(3);

-- Reservation and sale-cost integrity safeguards
ALTER TABLE "inventory"
  ADD CONSTRAINT "inventory_reserved_quantity_valid"
    CHECK ("reserved_quantity" >= 0 AND "reserved_quantity" <= "quantity");

ALTER TABLE "sale_items"
  ADD CONSTRAINT "sale_items_cost_price_at_sale_nonnegative"
    CHECK ("cost_price_at_sale" IS NULL OR "cost_price_at_sale" >= 0);
