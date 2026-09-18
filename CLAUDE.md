# stockflow-api

## Deploy branch

Render deploys this service from **`main`**, running `npm run prisma:deploy` (applies pending migrations) before starting the server on every deploy — see `render.yaml`. Merging to `main` is a production action: it redeploys the live API and runs migrations against the live database.

## Frontend

The frontend, `stockflow-web`, deploys from a differently-named branch (`codex/render-launch`, not `main`). Keep this in mind when a fix spans both repos.

## Sale price overrides

`POST /sales` and `PATCH /sales/:id` accept an optional `unitPrice` + `priceOverrideReason` per item, letting a cashier or admin charge something other than the catalogue/price-list price (e.g. a damaged-goods discount). A reason is required whenever `unitPrice` is sent; the sale total, item `unitPrice`, and `priceOverrideReason` are all derived from it, and the audit log records the override under `CREATE_SALE_WITH_PRICE_OVERRIDE` / `UPDATE_SALE_WITH_PRICE_OVERRIDE` (vs. the plain `CREATE_SALE`/`UPDATE_SALE` action when no item is overridden). Both ADMIN and CASHIER can create/edit sales and therefore both can apply an override — see `test/sale-price-override.test.js`.

## Known gaps

- Sales-import "rollback" (undoing an imported workbook's sales/inventory/expense changes) is not implemented. `SalesImportBatch` tracks import history and blocks duplicate uploads, but there is no rollback endpoint — reversing a historical inventory-balance replacement safely needs a dedicated design pass (see git history on `reportController`/`saleController` around the `SalesImportBatch` model for context).
