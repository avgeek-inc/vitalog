import { apiFetch } from "./browser-api";
import { notFound } from "next/navigation";
import type { Data, GoalProgress, HealthRecord } from "./health";

export async function readHealth<T>(path: string): Promise<T> {
  const response = await apiFetch(path);
  if (response.status === 401) {
    window.location.replace("/login");
    throw new Error("Session expired");
  }
  if (!response.ok) throw new Error("Health data is unavailable");
  return response.json();
}
export async function readRecords(
  filters: Record<string, string>,
  maximum = 1000,
) {
  const records: HealthRecord[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({
      ...filters,
      limit: "200",
      ...(cursor ? { cursor } : {}),
    });
    const page = await readHealth<{
      records: HealthRecord[];
      has_more: boolean;
      next_cursor: string | null;
    }>("/v1/records?" + params);
    records.push(...page.records);
    if (
      records.length > maximum ||
      (page.has_more && (!page.next_cursor || records.length >= maximum))
    )
      throw new Error("Too many records to display. Narrow the date range.");
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  return records;
}
export function selectedDate(
  value: string | string[] | undefined,
  today: string,
) {
  if (value === undefined) return today;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value + "T12:00:00Z").toISOString().slice(0, 10) !== value ||
    value > today
  )
    notFound();
  return value;
}
export async function readDaily(date: string) {
  const [summary, goals, records] = await Promise.all([
    readHealth<Data>(
      `/v1/days/${date}?sections=nutrition,hydration,activity,checkin`,
    ),
    readHealth<{ progress: GoalProgress[] }>(`/v1/days/${date}/goal-progress`),
    readRecords({ start_date: date, end_date: date }),
  ]);
  return { summary, goals: goals.progress, records };
}
