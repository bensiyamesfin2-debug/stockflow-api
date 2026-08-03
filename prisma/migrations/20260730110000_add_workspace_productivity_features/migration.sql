-- Workspace configuration and personal productivty features
ALTER TABLE "users" ADD COLUMN "two_factor_secret" VARCHAR(128);
ALTER TABLE "users" ADD COLUMN "two_factor_enabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "workspace_settings" (
    "id" SERIAL NOT NULL,
    "company_name" VARCHAR(160) NOT NULL DEFAULT 'StockFlow workspace',
    "company_code" VARCHAR(40),
    "primary_currency" VARCHAR(3) NOT NULL DEFAULT 'ETB',
    "locale" VARCHAR(10) NOT NULL DEFAULT 'en',
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Africa/Addis_Ababa',
    "invoice_email" VARCHAR(254),
    "invoice_phone" VARCHAR(40),
    "updated_by_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "workspace_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_preferences" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "theme" VARCHAR(10) NOT NULL DEFAULT 'system',
    "language" VARCHAR(10) NOT NULL DEFAULT 'en',
    "currency" VARCHAR(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "workspace_notes" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "title" VARCHAR(140) NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "color" VARCHAR(20) NOT NULL DEFAULT 'yellow',
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "workspace_notes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "calendar_events" (
    "id" SERIAL NOT NULL,
    "owner_id" INTEGER NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "description" TEXT,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "color" VARCHAR(20) NOT NULL DEFAULT 'teal',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "calendar_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "favorites" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "resource_type" VARCHAR(40) NOT NULL,
    "resource_id" VARCHAR(100) NOT NULL,
    "label" VARCHAR(160) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "favorites_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "file_attachments" (
    "id" SERIAL NOT NULL,
    "uploaded_by_id" INTEGER NOT NULL,
    "name" VARCHAR(180) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "resource_type" VARCHAR(40),
    "resource_id" VARCHAR(100),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "file_attachments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "invoice_templates" (
    "id" SERIAL NOT NULL,
    "created_by_id" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "header" VARCHAR(300),
    "footer" VARCHAR(500),
    "accent_color" VARCHAR(16) NOT NULL DEFAULT '#176b5d',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "invoice_templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_preferences_user_id_key" ON "user_preferences"("user_id");
CREATE INDEX "workspace_notes_user_id_is_pinned_updated_at_idx" ON "workspace_notes"("user_id", "is_pinned", "updated_at");
CREATE INDEX "calendar_events_starts_at_ends_at_idx" ON "calendar_events"("starts_at", "ends_at");
CREATE INDEX "calendar_events_owner_id_starts_at_idx" ON "calendar_events"("owner_id", "starts_at");
CREATE UNIQUE INDEX "favorites_user_id_resource_type_resource_id_key" ON "favorites"("user_id", "resource_type", "resource_id");
CREATE INDEX "favorites_user_id_created_at_idx" ON "favorites"("user_id", "created_at");
CREATE INDEX "file_attachments_resource_type_resource_id_idx" ON "file_attachments"("resource_type", "resource_id");
CREATE INDEX "file_attachments_uploaded_by_id_created_at_idx" ON "file_attachments"("uploaded_by_id", "created_at");
CREATE INDEX "invoice_templates_is_default_idx" ON "invoice_templates"("is_default");
CREATE INDEX "invoice_templates_created_by_id_created_at_idx" ON "invoice_templates"("created_by_id", "created_at");

ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workspace_notes" ADD CONSTRAINT "workspace_notes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "file_attachments" ADD CONSTRAINT "file_attachments_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invoice_templates" ADD CONSTRAINT "invoice_templates_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
