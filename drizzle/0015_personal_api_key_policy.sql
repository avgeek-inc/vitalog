ALTER TABLE "api_keys" ADD COLUMN "name" text;
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "access" text;
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "include_admin" boolean;
--> statement-breakpoint
-- Existing manual keys keep their health read/write ceiling and gain no administration.
UPDATE "api_keys" SET "name" = 'API key ' || left(id::text, 8), "access" = 'edit', "include_admin" = false WHERE left(token_hint, 4) = 'vlk_';
--> statement-breakpoint
ALTER TABLE "api_keys" DROP CONSTRAINT "api_key_lifetime";
--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "expires_at" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "expires_at" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_key_lifetime" CHECK ((left(token_hint, 4) = 'vlk_' AND (expires_at IS NULL OR expires_at > created_at)) OR (left(token_hint, 4) IN ('vls_', 'vlm_', 'vlo_') AND expires_at IS NOT NULL AND expires_at = created_at + CASE WHEN left(token_hint, 4) = 'vlm_' THEN interval '30 minutes' ELSE interval '720 hours' END));
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_key_manual_policy" CHECK ((left(token_hint, 4) = 'vlk_' AND name IS NOT NULL AND length(btrim(name)) BETWEEN 1 AND 120 AND access IS NOT NULL AND access IN ('read', 'edit') AND include_admin IS NOT NULL AND (NOT include_admin OR access = 'edit')) OR (left(token_hint, 4) <> 'vlk_' AND name IS NULL AND access IS NULL AND include_admin IS NULL));
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "creation_request_id" uuid;
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "creation_digest" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "api_key_creation_request" ON "api_keys" ("creation_request_id");
