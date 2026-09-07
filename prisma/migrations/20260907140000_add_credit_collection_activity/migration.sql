CREATE TABLE "credit_collection_activities" (
    "id" SERIAL NOT NULL,
    "sale_id" INTEGER NOT NULL,
    "activity_type" VARCHAR(30) NOT NULL,
    "channel" VARCHAR(30) NOT NULL,
    "note" TEXT,
    "created_by_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_collection_activities_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "credit_collection_activities_sale_id_created_at_idx" ON "credit_collection_activities"("sale_id", "created_at");

ALTER TABLE "credit_collection_activities" ADD CONSTRAINT "credit_collection_activities_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "credit_collection_activities" ADD CONSTRAINT "credit_collection_activities_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
