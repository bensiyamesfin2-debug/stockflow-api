-- Short-lived, single-use credentials for secure QR device pairing
CREATE TABLE "login_pairings" (
    "id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "user_id" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_pairings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "login_pairings_token_hash_key"
  ON "login_pairings"("token_hash");
CREATE INDEX "login_pairings_user_id_created_at_idx"
  ON "login_pairings"("user_id", "created_at");
CREATE INDEX "login_pairings_expires_at_idx"
  ON "login_pairings"("expires_at");

ALTER TABLE "login_pairings"
  ADD CONSTRAINT "login_pairings_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
