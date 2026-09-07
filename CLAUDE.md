# stockflow-api

## Deploy branch

Render deploys this service from **`main`**, running `npm run prisma:deploy` (applies pending migrations) before starting the server on every deploy — see `render.yaml`. Merging to `main` is a production action: it redeploys the live API and runs migrations against the live database.

## Frontend

The frontend, `stockflow-web`, deploys from a differently-named branch (`codex/render-launch`, not `main`). Keep this in mind when a fix spans both repos.

## Known gaps

- Sales-import "rollback" (undoing an imported workbook's sales/inventory/expense changes) is not implemented. `SalesImportBatch` tracks import history and blocks duplicate uploads, but there is no rollback endpoint — reversing a historical inventory-balance replacement safely needs a dedicated design pass (see git history on `reportController`/`saleController` around the `SalesImportBatch` model for context).
