CREATE TABLE "attachment_idempotency_requests" (
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"attachment_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "attachment_idempotency_requests_operation_idempotency_key_pk" PRIMARY KEY("operation","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_length" integer NOT NULL,
	"sha256" text NOT NULL,
	"status" text NOT NULL,
	"storage" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"upload_expires_at" timestamp with time zone NOT NULL,
	"ready_at" timestamp with time zone,
	"upload_pruned_at" timestamp with time zone,
	CONSTRAINT "attachment_size" CHECK ("attachments"."byte_length" > 0 and "attachments"."byte_length" <= 20000000),
	CONSTRAINT "attachment_sha256" CHECK ("attachments"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "attachment_state" CHECK (("attachments"."status" = 'ready' and "attachments"."ready_at" is not null) or ("attachments"."status" in ('pending', 'expired') and "attachments"."ready_at" is null)),
	CONSTRAINT "attachment_lifetime" CHECK ("attachments"."upload_expires_at" = "attachments"."created_at" + interval '15 minutes')
);
--> statement-breakpoint
CREATE TABLE "record_attachments" (
	"record_id" uuid NOT NULL,
	"record_version" integer NOT NULL,
	"attachment_id" uuid NOT NULL,
	CONSTRAINT "record_attachments_record_id_record_version_attachment_id_pk" PRIMARY KEY("record_id","record_version","attachment_id")
);
--> statement-breakpoint
ALTER TABLE "health_records" ADD COLUMN "attachment_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "attachment_idempotency_requests" ADD CONSTRAINT "attachment_idempotency_requests_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_attachments" ADD CONSTRAINT "record_attachments_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_attachments" ADD CONSTRAINT "record_attachments_record_id_record_version_record_revisions_record_id_version_fk" FOREIGN KEY ("record_id","record_version") REFERENCES "public"."record_revisions"("record_id","version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachment_creation_order" ON "attachments" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "attachment_status_expiry" ON "attachments" USING btree ("status","upload_expires_at");--> statement-breakpoint
CREATE INDEX "attachment_record_references" ON "record_attachments" USING btree ("attachment_id","record_id","record_version");