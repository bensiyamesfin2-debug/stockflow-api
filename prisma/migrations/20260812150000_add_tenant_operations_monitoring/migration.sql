ALTER TABLE "saas_tenants"
  ADD COLUMN "monitoring_token_hash" VARCHAR(64),
  ADD COLUMN "last_heartbeat_at" TIMESTAMPTZ(3),
  ADD COLUMN "last_health_status" VARCHAR(24) NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "last_database_ok" BOOLEAN,
  ADD COLUMN "last_version" VARCHAR(80),
  ADD COLUMN "last_uptime_seconds" INTEGER,
  ADD COLUMN "last_memory_mb" INTEGER,
  ADD COLUMN "last_error_at" TIMESTAMPTZ(3);

CREATE TABLE "tenant_error_aggregates" (
  "id" SERIAL NOT NULL,
  "tenant_id" UUID NOT NULL,
  "fingerprint" VARCHAR(64) NOT NULL,
  "error_type" VARCHAR(120) NOT NULL,
  "route" VARCHAR(200) NOT NULL,
  "method" VARCHAR(10) NOT NULL,
  "status_code" INTEGER NOT NULL,
  "occurrence_count" INTEGER NOT NULL DEFAULT 1,
  "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMPTZ(3),
  CONSTRAINT "tenant_error_aggregates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_error_aggregates_tenant_id_fingerprint_key"
  ON "tenant_error_aggregates"("tenant_id", "fingerprint");
CREATE INDEX "tenant_error_aggregates_resolved_at_last_seen_at_idx"
  ON "tenant_error_aggregates"("resolved_at", "last_seen_at");
CREATE INDEX "tenant_error_aggregates_tenant_id_occurrence_count_idx"
  ON "tenant_error_aggregates"("tenant_id", "occurrence_count");

ALTER TABLE "tenant_error_aggregates"
  ADD CONSTRAINT "tenant_error_aggregates_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "saas_tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
