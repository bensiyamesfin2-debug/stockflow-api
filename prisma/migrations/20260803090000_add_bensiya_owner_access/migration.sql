-- Ben IT Solutions' private console is deliberately separate from customer workspaces.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "is_platform_owner" BOOLEAN NOT NULL DEFAULT false;

UPDATE "workspace_settings"
SET "company_name" = 'Bensiya PLC'
WHERE "company_name" = 'StockFlow workspace';
