-- Bensiya PLC is a paying StockFlow customer and belongs in subscription revenue.
UPDATE "saas_tenants"
SET "subscription_exempt" = false
WHERE "slug" = 'bensiya-plc';
