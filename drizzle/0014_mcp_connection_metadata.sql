ALTER TABLE "api_keys" ADD COLUMN "oauth_client_id" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "oauth_client_name" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "oauth_scopes" text[];--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD COLUMN "client_name" text;