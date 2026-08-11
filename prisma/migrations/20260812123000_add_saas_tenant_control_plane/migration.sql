CREATE TYPE "SaasTenantStatus" AS ENUM ('PROVISIONING', 'ACTIVE', 'SUSPENDED', 'ARCHIVED');

CREATE TABLE "saas_tenants" (
    "id" UUID NOT NULL,
    "company_name" VARCHAR(160) NOT NULL,
    "company_code" VARCHAR(40) NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "status" "SaasTenantStatus" NOT NULL DEFAULT 'PROVISIONING',
    "plan" VARCHAR(24) NOT NULL DEFAULT 'GROWTH',
    "primary_currency" VARCHAR(3) NOT NULL DEFAULT 'ETB',
    "locale" VARCHAR(10) NOT NULL DEFAULT 'en',
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Africa/Addis_Ababa',
    "region" VARCHAR(48) NOT NULL DEFAULT 'africa-east1',
    "deployment_url" VARCHAR(500),
    "database_isolation" VARCHAR(32) NOT NULL DEFAULT 'DEDICATED_DATABASE',
    "notes" TEXT,
    "created_by_id" INTEGER,
    "activated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "saas_tenants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "saas_tenants_company_code_key" ON "saas_tenants"("company_code");
CREATE UNIQUE INDEX "saas_tenants_slug_key" ON "saas_tenants"("slug");
CREATE UNIQUE INDEX "saas_tenants_deployment_url_key" ON "saas_tenants"("deployment_url");
CREATE INDEX "saas_tenants_status_created_at_idx" ON "saas_tenants"("status", "created_at");
CREATE INDEX "saas_tenants_created_by_id_idx" ON "saas_tenants"("created_by_id");

ALTER TABLE "saas_tenants"
ADD CONSTRAINT "saas_tenants_created_by_id_fkey"
FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
