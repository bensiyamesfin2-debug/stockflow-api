-- This migration was introduced after the later-named migration that creates
-- sales_leads. Existing deployments already had the table, but a fresh
-- database replays migrations by name and reaches this file first.
DO $$
BEGIN
  IF to_regclass('public.sales_leads') IS NOT NULL THEN
    ALTER TABLE "sales_leads"
    ADD COLUMN IF NOT EXISTS "interest" VARCHAR(50) NOT NULL DEFAULT 'STOCKFLOW';
  END IF;
END
$$;
