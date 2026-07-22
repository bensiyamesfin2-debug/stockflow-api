-- Persistent account protection and session invalidation controls
ALTER TABLE "users"
  ADD COLUMN "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "locked_until" TIMESTAMPTZ(3),
  ADD COLUMN "last_login_at" TIMESTAMPTZ(3),
  ADD COLUMN "password_changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "token_version" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "users"
  ADD CONSTRAINT "users_failed_login_attempts_nonnegative"
    CHECK ("failed_login_attempts" >= 0),
  ADD CONSTRAINT "users_token_version_nonnegative"
    CHECK ("token_version" >= 0);
