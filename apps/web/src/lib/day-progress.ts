import { parseDate } from "@internationalized/date";

export function dayProgressPercent(
  date: string,
  timezone: string,
  now: number,
): number | null {
  const day = parseDate(date);
  const start = day.toDate(timezone).getTime();
  const end = day.add({ days: 1 }).toDate(timezone).getTime();
  if (now < start || now >= end) return null;
  return ((now - start) / (end - start)) * 100;
}
