CREATE TABLE "notifications" (
  "id" SERIAL NOT NULL,
  "user_id" INTEGER NOT NULL,
  "sale_id" INTEGER,
  "type" VARCHAR(50) NOT NULL,
  "title" VARCHAR(160) NOT NULL,
  "message" TEXT NOT NULL,
  "read_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "notifications_user_id_read_at_created_at_idx"
  ON "notifications"("user_id", "read_at", "created_at");

CREATE INDEX "notifications_sale_id_idx"
  ON "notifications"("sale_id");

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_sale_id_fkey"
  FOREIGN KEY ("sale_id") REFERENCES "sales"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
