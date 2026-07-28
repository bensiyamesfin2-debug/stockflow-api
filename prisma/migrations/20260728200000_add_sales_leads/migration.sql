CREATE TABLE "sales_leads" (
  "id" SERIAL NOT NULL,
  "full_name" VARCHAR(100) NOT NULL,
  "business_name" VARCHAR(150) NOT NULL,
  "phone" VARCHAR(30) NOT NULL,
  "city" VARCHAR(100),
  "message" TEXT,
  "status" VARCHAR(30) NOT NULL DEFAULT 'NEW',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "sales_leads_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sales_leads_status_created_at_idx"
ON "sales_leads"("status", "created_at");
