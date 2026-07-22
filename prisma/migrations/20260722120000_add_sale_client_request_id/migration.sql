ALTER TABLE "sales"
ADD COLUMN "client_request_id" UUID;

CREATE UNIQUE INDEX "sales_client_request_id_key"
ON "sales"("client_request_id");
