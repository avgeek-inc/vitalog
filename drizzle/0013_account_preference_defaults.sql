ALTER TABLE "account_settings" ALTER COLUMN "date_format" SET DEFAULT 'day-short-month-year';--> statement-breakpoint
ALTER TABLE "account_settings" ALTER COLUMN "time_format" SET DEFAULT '24-hour';--> statement-breakpoint
ALTER TABLE "account_settings" ALTER COLUMN "time_zone" SET DEFAULT 'UTC';