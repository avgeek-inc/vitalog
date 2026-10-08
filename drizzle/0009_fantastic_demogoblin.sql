CREATE TABLE "goal_idempotency_requests" (
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "goal_idempotency_requests_operation_idempotency_key_pk" PRIMARY KEY("operation","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "goal_revisions" (
	"goal_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"effective_on" date NOT NULL,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "goal_revisions_goal_id_version_pk" PRIMARY KEY("goal_id","version")
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"metric" text NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "goal_positive_version" CHECK ("goals"."version" > 0),
	CONSTRAINT "goal_snapshot_identity" CHECK ("goals"."snapshot"->>'id' = "goals"."id"::text and "goals"."snapshot"->>'metric' = "goals"."metric" and ("goals"."snapshot"->>'version')::integer = "goals"."version")
);
--> statement-breakpoint
ALTER TABLE "goal_revisions" ADD CONSTRAINT "goal_revisions_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goal_effective_date" ON "goal_revisions" USING btree ("effective_on","goal_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "one_goal_per_metric" ON "goals" USING btree ("metric");