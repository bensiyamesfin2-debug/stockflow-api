ALTER TABLE "saas_tenants"
ADD COLUMN "monthly_price_minor" INTEGER NOT NULL DEFAULT 1000000,
ADD COLUMN "subscription_currency" VARCHAR(3) NOT NULL DEFAULT 'ETB',
ADD COLUMN "subscription_ends_at" TIMESTAMPTZ(3),
ADD COLUMN "last_subscription_payment_at" TIMESTAMPTZ(3),
ADD COLUMN "subscription_exempt" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "tenant_subscription_payments" (
  "id" SERIAL NOT NULL,
  "tenant_id" UUID NOT NULL,
  "amount_minor" INTEGER NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'ETB',
  "covered_from" TIMESTAMPTZ(3) NOT NULL,
  "covered_until" TIMESTAMPTZ(3) NOT NULL,
  "recorded_by_id" INTEGER NOT NULL,
  "paid_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tenant_subscription_payments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tenant_subscription_payments_tenant_id_paid_at_idx" ON "tenant_subscription_payments"("tenant_id", "paid_at");
CREATE INDEX "tenant_subscription_payments_paid_at_idx" ON "tenant_subscription_payments"("paid_at");
ALTER TABLE "tenant_subscription_payments" ADD CONSTRAINT "tenant_subscription_payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "saas_tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenant_subscription_payments" ADD CONSTRAINT "tenant_subscription_payments_recorded_by_id_fkey" FOREIGN KEY ("recorded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
UPDATE "saas_tenants" SET "subscription_exempt" = true WHERE "slug" = 'bensiya-plc';
