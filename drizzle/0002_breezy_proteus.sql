CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"token_digest" text NOT NULL,
	"token_hint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT statement_timestamp() + interval '720 hours' NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_key_lifetime" CHECK ("api_keys"."expires_at" = "api_keys"."created_at" + interval '720 hours'),
	CONSTRAINT "api_key_name" CHECK (length("api_keys"."name") between 1 and 80),
	CONSTRAINT "api_key_sha256" CHECK ("api_keys"."token_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "api_key_digest" ON "api_keys" USING btree ("token_digest");--> statement-breakpoint
CREATE INDEX "api_key_creation_order" ON "api_keys" USING btree ("created_at","id");