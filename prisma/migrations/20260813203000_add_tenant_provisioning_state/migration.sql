ALTER TABLE "saas_tenants"
ADD COLUMN "provisioning_status" VARCHAR(32) NOT NULL DEFAULT 'NOT_STARTED',
ADD COLUMN "provisioning_step" VARCHAR(80),
ADD COLUMN "provisioning_error" TEXT,
ADD COLUMN "provider" VARCHAR(32),
ADD COLUMN "provider_database_id" VARCHAR(80),
ADD COLUMN "provider_service_id" VARCHAR(80),
ADD COLUMN "provider_deploy_id" VARCHAR(80),
ADD COLUMN "backend_url" VARCHAR(500),
ADD COLUMN "provisioning_started_at" TIMESTAMPTZ(3),
ADD COLUMN "provisioning_completed_at" TIMESTAMPTZ(3);

CREATE UNIQUE INDEX "saas_tenants_provider_database_id_key" ON "saas_tenants"("provider_database_id");
CREATE UNIQUE INDEX "saas_tenants_provider_service_id_key" ON "saas_tenants"("provider_service_id");
CREATE UNIQUE INDEX "saas_tenants_backend_url_key" ON "saas_tenants"("backend_url");
