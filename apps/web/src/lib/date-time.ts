import type { Account } from "../../../../src/auth/account-contracts.js";
export type Preferences = Account["preferences"];
export function formatDateTime(value: string, preferences: Preferences) {
  const calendarDate = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const instant = new Date(calendarDate ? value + "T12:00:00Z" : value);
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
  const dates = {
    "day-short-month-year": `${Number(parts.day)} ${month} ${parts.year}`,
    "short-month-day-year": `${month} ${Number(parts.day)}, ${parts.year}`,
    "year-month-day": `${parts.year}-${parts.month}-${parts.day}`,
    "day-month-year": `${parts.day}/${parts.month}/${parts.year}`,
    "month-day-year": `${parts.month}/${parts.day}/${parts.year}`,
  };
  const twelve = preferences.timeFormat.startsWith("12");
  const hour = Number(parts.hour);
  const time = `${twelve ? hour % 12 || 12 : parts.hour}:${parts.minute}${preferences.timeFormat.endsWith("seconds") ? ":" + parts.second : ""}${twelve ? (hour < 12 ? " AM" : " PM") : ""}`;
  return {
    date: dates[preferences.dateFormat],
    time,
    dateTime: `${time}, ${dates[preferences.dateFormat]}`,
  };
}
