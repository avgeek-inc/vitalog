import type { Account } from "../../../../src/auth/account-contracts.js";
export type Preferences = Account["preferences"];
export function formatDateTime(value: string, preferences: Preferences) {
  const calendarDate = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const instant = new Date(calendarDate ? value + "T12:00:00Z" : value);
  if (
    !Number.isFinite(instant.getTime()) ||
    (calendarDate && instant.toISOString().slice(0, 10) !== value)
  )
    throw new RangeError("Invalid date");
  const zone = calendarDate ? "UTC" : preferences.timeZone;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  const month = new Intl.DateTimeFormat("en-GB", {
    month: "short",
    timeZone: zone,
  }).format(instant);
  const [year, numericMonth, day] = calendarDate
    ? value.split("-")
    : [parts.year, parts.month, parts.day];
  const dates = {
    "day-short-month-year": `${Number(day)} ${month} ${year}`,
    "short-month-day-year": `${month} ${Number(day)}, ${year}`,
    "year-month-day": `${year}-${numericMonth}-${day}`,
    "day-month-year": `${day}/${numericMonth}/${year}`,
    "month-day-year": `${numericMonth}/${day}/${year}`,
  };
  const twelve = preferences.timeFormat.startsWith("12");
  const hour = Number(parts.hour);
  const time = `${twelve ? hour % 12 || 12 : parts.hour}:${parts.minute}${preferences.timeFormat.endsWith("seconds") ? ":" + parts.second : ""}${twelve ? (hour < 12 ? " AM" : " PM") : ""}`;
  return {
    date: dates[preferences.dateFormat],
    time: calendarDate ? null : time,
    dateTime: calendarDate ? null : `${time}, ${dates[preferences.dateFormat]}`,
  };
}
