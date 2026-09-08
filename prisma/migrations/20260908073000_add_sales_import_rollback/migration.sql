ALTER TABLE "sales_import_batches" ADD COLUMN "manifest" JSONB;
ALTER TABLE "sales_import_batches" ADD COLUMN "rolled_back_at" TIMESTAMPTZ(3);
ALTER TABLE "sales_import_batches" ADD COLUMN "rolled_back_by_id" INTEGER;

ALTER TABLE "sales_import_batches" ADD CONSTRAINT "sales_import_batches_rolled_back_by_id_fkey" FOREIGN KEY ("rolled_back_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
