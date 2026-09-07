CREATE TABLE "sales_import_batches" (
    "id" SERIAL NOT NULL,
    "file_name" VARCHAR(255),
    "file_hash" VARCHAR(64) NOT NULL,
    "summary" JSONB NOT NULL,
    "created_by_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_import_batches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sales_import_batches_file_hash_key" ON "sales_import_batches"("file_hash");

ALTER TABLE "sales_import_batches" ADD CONSTRAINT "sales_import_batches_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
