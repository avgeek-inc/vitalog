CREATE TABLE "oauth_clients" (
	"client_id" text PRIMARY KEY NOT NULL,
	"metadata" jsonb NOT NULL,
	"client_secret_digest" text,
	"created_at" timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
	CONSTRAINT "oauth_client_id" CHECK ("oauth_clients"."client_id" ~ '^vcl_[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "oauth_client_secret_sha256" CHECK ("oauth_clients"."client_secret_digest" is null or "oauth_clients"."client_secret_digest" ~ '^[0-9a-f]{64}$')
);
