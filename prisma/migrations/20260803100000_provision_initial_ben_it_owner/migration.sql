-- Provision the requested Ben IT Solutions owner account. The password is stored
-- only as a bcrypt hash and can be changed from the account security screen.
INSERT INTO "users" (
  "full_name",
  "username",
  "password_hash",
  "role",
  "is_active",
  "is_platform_owner",
  "password_changed_at",
  "created_at",
  "updated_at"
)
VALUES (
  'Patrick Jane',
  'patrick.jane',
  '$2b$12$lOkuUxFUhFHQfwLq1lTu2.8CM2TT5oKSt0Z6zlPsdIqqggXyr./Tm',
  'ADMIN',
  true,
  true,
  NOW(),
  NOW(),
  NOW()
)
ON CONFLICT ("username") DO UPDATE
SET
  "full_name" = EXCLUDED."full_name",
  "password_hash" = EXCLUDED."password_hash",
  "is_active" = true,
  "is_platform_owner" = true,
  "token_version" = "users"."token_version" + 1,
  "updated_at" = NOW();
