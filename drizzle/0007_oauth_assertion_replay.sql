CREATE TABLE "oauth_client_assertions" (
	"assertion_digest" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "oauth_client_assertion_sha256" CHECK ("oauth_client_assertions"."assertion_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX "oauth_client_assertion_expiry" ON "oauth_client_assertions" USING btree ("expires_at");