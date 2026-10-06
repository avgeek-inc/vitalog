CREATE TABLE "account_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"date_format" text NOT NULL,
	"time_format" text NOT NULL,
	"time_zone" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_settings_singleton" CHECK ("account_settings"."id" = 1),
	CONSTRAINT "account_name_length" CHECK (length(btrim("account_settings"."name")) between 1 and 120),
	CONSTRAINT "account_date_format" CHECK ("account_settings"."date_format" in ('day-short-month-year', 'short-month-day-year', 'year-month-day', 'day-month-year', 'month-day-year')),
	CONSTRAINT "account_time_format" CHECK ("account_settings"."time_format" in ('24-hour', '12-hour', '24-hour-seconds', '12-hour-seconds')),
	CONSTRAINT "account_time_zone_length" CHECK (length("account_settings"."time_zone") between 1 and 100)
);
