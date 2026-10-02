ALTER TABLE "health_records" ADD COLUMN "time_context" jsonb DEFAULT '{"original_occurred_at":null,"original_ended_at":null,"supplied_timezone":null}'::jsonb NOT NULL;
