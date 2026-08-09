# StockFlow customer isolation

StockFlow uses one backend deployment and one PostgreSQL database per customer. It does not place unrelated companies in shared tables. This is the production boundary: a Bensiya PLC process has only Bensiya's `DATABASE_URL`, JWT secret, web origin, and instance company code.

For every new customer create a new Railway service and PostgreSQL database, then set unique values for `DATABASE_URL`, `JWT_SECRET`, `INSTANCE_COMPANY_CODE`, `CLIENT_URLS`, VAPID keys, and WhatsApp credentials. Never copy a production database into another customer's live environment. Product setup may be imported through an approved export after removing sales, staff, customer, payment, and audit records.

Before handoff verify `/api/health` reports the expected `instanceCompanyCode` and `DEDICATED_DATABASE`, confirm an account/token from another instance is rejected, and run the authorization tests. Database credentials must remain server-side; the frontend receives only the public API address.

# Isolation release checklist

1. New Railway project, service, and PostgreSQL database.
2. Unique 32+ character JWT secret and unique instance company code.
3. Exact HTTPS frontend origin in `CLIENT_URLS`.
4. Apply migrations with `npm run prisma:deploy`.
5. Create that customer's administrator only.
6. Confirm company branding and opening stock.
7. Test cross-instance token rejection and role restrictions.
8. Enable provider backups before entering live transactions.
