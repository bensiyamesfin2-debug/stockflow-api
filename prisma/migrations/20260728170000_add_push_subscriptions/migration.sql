CREATE TABLE "push_subscriptions" (
  "id" SERIAL NOT NULL,
  "user_id" INTEGER NOT NULL,
  "endpoint" TEXT NOT NULL,
  "p256dh" VARCHAR(255) NOT NULL,
  "auth" VARCHAR(255) NOT NULL,
  "expiration_time" BIGINT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "push_subscriptions_endpoint_key"
  ON "push_subscriptions"("endpoint");

CREATE INDEX "push_subscriptions_user_id_idx"
  ON "push_subscriptions"("user_id");

ALTER TABLE "push_subscriptions"
  ADD CONSTRAINT "push_subscriptions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
