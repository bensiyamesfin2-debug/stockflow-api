CREATE TYPE "OwnerExpenseEntryType" AS ENUM ('IN', 'OUT');

CREATE TABLE "owner_expense_entries" (
    "id" SERIAL NOT NULL,
    "entry_type" "OwnerExpenseEntryType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "balance_after" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "transaction_date" TIMESTAMPTZ(3) NOT NULL,
    "created_by_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "owner_expense_entries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "owner_expense_entries_amount_positive" CHECK ("amount" > 0),
    CONSTRAINT "owner_expense_entries_balance_nonnegative" CHECK ("balance_after" >= 0)
);

CREATE INDEX "owner_expense_entries_transaction_date_id_idx" ON "owner_expense_entries"("transaction_date", "id");
CREATE INDEX "owner_expense_entries_created_by_id_idx" ON "owner_expense_entries"("created_by_id");

ALTER TABLE "owner_expense_entries"
ADD CONSTRAINT "owner_expense_entries_created_by_id_fkey"
FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
