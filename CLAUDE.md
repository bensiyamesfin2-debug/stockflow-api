# stockflow-api

## Deploy branch

Render deploys this service from **`main`**, running `npm run prisma:deploy` (applies pending migrations) before starting the server on every deploy — see `render.yaml`. Merging to `main` is a production action: it redeploys the live API and runs migrations against the live database.

## Frontend

The frontend, `stockflow-web`, deploys from a differently-named branch (`codex/render-launch`, not `main`). Keep this in mind when a fix spans both repos.

## Sales-import rollback

`POST /sales/import/batches/:id/rollback` (ADMIN only) undoes an imported workbook's sales,
inventory, price, and expense-account changes. `importSales` now records a `manifest` JSON on
`SalesImportBatch` with everything needed to reverse it (created sale/payment IDs and their
original status, price changes with before/after cents, inventory-replacement before/after
snapshots, and the inventory-movement and expense-entry IDs it created).

Rollback only proceeds when it's provably safe, and refuses with a clear 409 otherwise:
- Only the most recently imported, not-yet-rolled-back batch is eligible — imports must be
  undone most-recent-first (`GET /sales/import/batches` reports this per batch as `canRollback`).
- Refuses if any imported sale has since been released, returned, paid further, or had credit
  collection activity, or if its status no longer matches what the import set.
- Refuses to revert an inventory-balance replacement if that product's stock has changed since
  import (something else — a receipt, another sale — touched it), rather than silently
  overwriting an unrelated change.
- Refuses to revert expense-account entries if any later entry exists (deleting older entries
  would break the running balance chain for everything after them).
- Product price reverts only apply if nobody changed the price again since import; created
  products are never deleted (safer to leave an unused product than risk deleting one that's
  since been referenced elsewhere).

Batches imported before this feature shipped have no `manifest` and can't be rolled back
automatically.
