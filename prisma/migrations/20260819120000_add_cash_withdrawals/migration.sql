CREATE TABLE "cash_withdrawals" (
    "id" SERIAL NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "withdrawn_by_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_withdrawals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cash_withdrawals_withdrawn_by_id_idx" ON "cash_withdrawals"("withdrawn_by_id");

CREATE INDEX "cash_withdrawals_created_at_idx" ON "cash_withdrawals"("created_at");

ALTER TABLE "cash_withdrawals" ADD CONSTRAINT "cash_withdrawals_withdrawn_by_id_fkey" FOREIGN KEY ("withdrawn_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
