CREATE TABLE "health_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"record_type" text NOT NULL,
	"schema_version" integer NOT NULL,
	"version" integer NOT NULL,
	"occurred_on" date,
	"occurred_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"timezone" text NOT NULL,
	"time_precision" text NOT NULL,
	"date_basis" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"validity" text NOT NULL,
	"provenance" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "valid_record_type" CHECK ("health_records"."record_type" in ('measurement','nutrition','hydration','activity','sleep','checkin','intake','lab_result')),
	CONSTRAINT "positive_version" CHECK ("health_records"."version" > 0 and "health_records"."schema_version" > 0),
	CONSTRAINT "valid_status" CHECK ("health_records"."status" in ('active','voided')),
	CONSTRAINT "valid_quality" CHECK ("health_records"."validity" in ('valid','suspect','invalid')),
	CONSTRAINT "dated_non_lab" CHECK ("health_records"."record_type" = 'lab_result' or "health_records"."occurred_on" is not null)
);
--> statement-breakpoint
CREATE TABLE "idempotency_requests" (
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"result_metadata" jsonb NOT NULL,
	"committed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_requests_operation_idempotency_key_pk" PRIMARY KEY("operation","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "record_revisions" (
	"record_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "record_revisions_record_id_version_pk" PRIMARY KEY("record_id","version"),
	CONSTRAINT "revision_positive" CHECK ("record_revisions"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "record_revisions" ADD CONSTRAINT "record_revisions_record_id_health_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."health_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "record_history_order" ON "health_records" USING btree ("occurred_on","recorded_at","id");--> statement-breakpoint
CREATE INDEX "type_date" ON "health_records" USING btree ("record_type","occurred_on");--> statement-breakpoint
CREATE INDEX "source_type" ON "health_records" USING btree (("provenance"->>'source_type'));--> statement-breakpoint
CREATE INDEX "metric_key" ON "health_records" USING btree (("payload"->>'metric_key'));--> statement-breakpoint
CREATE INDEX "analyte_key" ON "health_records" USING btree (("payload"->>'analyte_key'));--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_daily_total" ON "health_records" USING btree ("record_type","occurred_on") WHERE "health_records"."status" = 'active' and "health_records"."payload"->>'entry_kind' = 'daily_total' and "health_records"."record_type" in ('nutrition','hydration','activity');