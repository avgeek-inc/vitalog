CREATE TABLE "oauth_authorization_codes" (
	"code_digest" text PRIMARY KEY NOT NULL,
	"api_key_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"resource" text NOT NULL,
	"scopes" text[] NOT NULL,
	"code_challenge" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT statement_timestamp() + interval '300 seconds' NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "oauth_code_sha256" CHECK ("oauth_authorization_codes"."code_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "oauth_code_pkce" CHECK ("oauth_authorization_codes"."code_challenge" ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "oauth_code_lifetime" CHECK ("oauth_authorization_codes"."expires_at" = "oauth_authorization_codes"."created_at" + interval '300 seconds'),
	CONSTRAINT "oauth_code_scopes" CHECK (cardinality("oauth_authorization_codes"."scopes") > 0 and "oauth_authorization_codes"."scopes" <@ array['health:read', 'health:write']::text[])
);
--> statement-breakpoint
CREATE TABLE "oauth_access_tokens" (
	"token_digest" text PRIMARY KEY NOT NULL,
	"api_key_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "oauth_token_sha256" CHECK ("oauth_access_tokens"."token_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "oauth_token_lifetime" CHECK ("oauth_access_tokens"."expires_at" > "oauth_access_tokens"."created_at" and "oauth_access_tokens"."expires_at" <= "oauth_access_tokens"."created_at" + interval '720 hours'),
	CONSTRAINT "oauth_token_scopes" CHECK (cardinality("oauth_access_tokens"."scopes") > 0 and "oauth_access_tokens"."scopes" <@ array['health:read', 'health:write']::text[])
);
--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_code_expiry" ON "oauth_authorization_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_token_expiry" ON "oauth_access_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_token_key" ON "oauth_access_tokens" USING btree ("api_key_id");