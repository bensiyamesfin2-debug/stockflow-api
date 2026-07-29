-- Guarantees the interest column exists after sales_leads has been created.
-- This keeps both existing deployments and clean database bootstraps valid.
ALTER TABLE "sales_leads"
ADD COLUMN IF NOT EXISTS "interest" VARCHAR(50) NOT NULL DEFAULT 'STOCKFLOW';
