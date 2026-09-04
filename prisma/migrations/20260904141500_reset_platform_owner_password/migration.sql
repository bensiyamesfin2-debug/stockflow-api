-- Reset the existing platform-owner account after the owner lost access.
-- The plaintext password is not stored; only a bcrypt hash is committed.
UPDATE "users"
SET
  "password_hash" = '$2b$12$.TuJG2ndTsOKw.50403kM.mEWLnso5bEfdRV1C02WYHwvyOW9BDM.',
  "is_active" = true,
  "is_platform_owner" = true,
  "failed_login_attempts" = 0,
  "locked_until" = NULL,
  "password_changed_at" = NOW(),
  "token_version" = "token_version" + 1,
  "updated_at" = NOW()
WHERE "username" = 'patrick.jane';
