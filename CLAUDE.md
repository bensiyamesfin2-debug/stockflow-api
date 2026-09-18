# stockflow-api

## Deploy branch

Render deploys this service from **`main`**, running `npm run prisma:deploy` (applies pending migrations) before starting the server on every deploy — see `render.yaml`. Merging to `main` is a production action: it redeploys the live API and runs migrations against the live database.

## Frontend

The frontend, `stockflow-web`, deploys from a differently-named branch (`codex/render-launch`, not `main`). Keep this in mind when a fix spans both repos.

## Sale price overrides

`POST /sales` and `PATCH /sales/:id` accept an optional `unitPrice` + `priceOverrideReason` per item, letting a cashier or admin charge something other than the catalogue/price-list price (e.g. a damaged-goods discount). A reason is required whenever `unitPrice` is sent; the sale total, item `unitPrice`, and `priceOverrideReason` are all derived from it, and the audit log records the override under `CREATE_SALE_WITH_PRICE_OVERRIDE` / `UPDATE_SALE_WITH_PRICE_OVERRIDE` (vs. the plain `CREATE_SALE`/`UPDATE_SALE` action when no item is overridden). Both ADMIN and CASHIER can create/edit sales and therefore both can apply an override — see `test/sale-price-override.test.js`.

## Custom order cut size vs. ordered size

`SaleItem.customLength/customWidth/customThickness` is what the customer ordered. `POST /sales` and `PATCH /sales/:id` also accept an optional `cutLength`/`cutWidth`/`cutThickness` on an item's `customMeasurement`, stored as `cutLength/cutWidth/cutThickness` — the size actually cut from the stock slab when it differs from the order (e.g. rounded up to the nearest size the slab supports). All three cut fields must be sent together or omitted together (`normalizeCustomMeasurement` in `src/utils/customOrder.js` rejects a partial set). When omitted, cut size is `null` and every caller (bin-packing in `planCustomCuts`/`calculateCustomOrder`, and the stock-fit/thickness checks) falls back to the ordered size — see `cutSizeOf()`. Reports and exports (`professionalWorkbook.js`, `exportController.js`) still summarize sales by the ordered size, since that's what the customer bought; they do not yet break out the cut size separately.

## Bulk sale entry import (`GET/POST /sales/import*`)

`downloadSalesImportTemplate` generates the "Sale Entry" workbook (`src/controllers/saleController.js`), and `parseSalesWorkbook`/`salesImportPlan`/`importSales` read it back. This replaced the old "Complete Operations" template (historical sales + inventory balance corrections + owner expense entries + inventory movement history) — that multi-purpose historical-migration tool is gone, along with the `historical`/`LEGACY_UNKNOWN` row concept, `Beginning Balance`/`Remaining Inventory` columns, and the `Inventory History`/`Owner Expense Account` sheets.

Every row in the new template now behaves exactly like a live cashier sale:
- `Material / Product` must match an **existing, active** catalogue item (via `resolveProduct`) — the importer no longer auto-creates new products.
- `Customer Length/Width/Thickness (cm)` are optional and, when filled in together, describe a custom-cut piece exactly like a live sale's `customMeasurement`. `Stock Cut Length/Width/Thickness (cm)` are also optional and record the actual cut size when it differs from the order (same `cutLength/cutWidth/cutThickness` semantics as the live sale flow — see the "Custom order cut size vs. ordered size" section above). `Quantity` for a custom row is pieces wanted; `calculateCustomOrder` (in `salesImportPlan`) converts that into the stock units actually reserved.
- Every row reserves inventory (`PENDING_RELEASE`, sent to warehouse release) and is priced per stock unit consumed from `Customer Line Total`, matching `effectivePrice() * quantity` in the cashier cart — never per piece.
- `Payment Type` is `Bank Transfer`, `Mobile Money`, `Card`, `Cash`, or `Credit` — there is no more "Legacy / Unknown" option.

`SalesImportBatch` still tracks import history and blocks duplicate uploads. "Rollback" (undoing an imported workbook's sales/inventory changes) is still not implemented — there is no rollback endpoint.
