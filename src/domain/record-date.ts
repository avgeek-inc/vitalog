import type { HealthRecord } from "./types.js";

export const localDate = (instant: string | Date, timezone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));

export function recordCalendarDate(
  record: Pick<
    HealthRecord,
    "occurred_on" | "occurred_at" | "ended_at" | "time_precision" | "date_basis"
  >,
  timezone: string,
): string | null {
  if (record.time_precision !== "instant") return record.occurred_on;
  const instant =
    record.date_basis === "wake_date" ? record.ended_at : record.occurred_at;
  return instant ? localDate(instant, timezone) : record.occurred_on;
}

export function recordInTimezone(
  record: HealthRecord,
  timezone: string,
): HealthRecord {
  return { ...record, occurred_on: recordCalendarDate(record, timezone) };
}
