# Backup and restore runbook

Use two layers: Railway PostgreSQL backups for disaster recovery and StockFlow's encrypted admin export for a portable business archive. A backup is not proven until a restore drill succeeds.

## Automatic provider backup

Enable scheduled PostgreSQL backups in the customer's Railway project. Keep each customer's backups in that customer's project. Record retention and the last successful backup in the service agreement. Configure an external uptime monitor against `/api/health`.

## Encrypted StockFlow export

An administrator opens Security, downloads an encrypted backup, and stores the passphrase separately. The export now covers sales, returns, payments, inventory, batches, locations, transfers, price lists, quotes, users, audit records, and workspace data.

## Restore procedure

1. Stop writes by placing the service in maintenance mode or scaling it to zero.
2. Create a new empty PostgreSQL database; never test a restore over the only live copy.
3. Restore the Railway/PostgreSQL snapshot into the new database.
4. Point a temporary backend service at the restored database and run `npm run prisma:deploy`.
5. Verify `/api/health`, record counts, recent sales, payments, total stock, reserved stock, and audit entries.
6. Test one admin login and role-restricted cashier/inventory routes.
7. Swap `DATABASE_URL` only after written approval, then retain the previous database until reconciliation is complete.

The encrypted JSON export is an audit/archive format. Restore live service from a PostgreSQL snapshot so foreign keys, sequences, decimal precision, and transaction history remain exact.
