import { z } from "zod";

export const dateFormatOptions = [
  { id: "day-short-month-year", label: "16 Sept 2026" },
  { id: "short-month-day-year", label: "Sept 16, 2026" },
  { id: "year-month-day", label: "2026-09-16" },
  { id: "day-month-year", label: "16/09/2026" },
  { id: "month-day-year", label: "09/16/2026" },
] as const;
export const timeFormatOptions = [
  { id: "24-hour", label: "14:30" },
  { id: "12-hour", label: "2:30 PM" },
  { id: "24-hour-seconds", label: "14:30:45" },
  { id: "12-hour-seconds", label: "2:30:45 PM" },
] as const;
export const defaultDateTimePreferences = {
  dateFormat: "day-short-month-year",
  timeFormat: "24-hour",
  timeZone: "UTC",
} as const;
export function isTimeZone(value: string) {
  if (!value || value.length > 100 || /^[+-]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
export function availableTimeZones() {
  return [
    ...new Set(
      [
        "UTC",
        ...Intl.supportedValuesOf("timeZone"),
        "Asia/Kolkata",
        "Asia/Kathmandu",
        "Asia/Yangon",
        "Europe/Kyiv",
        "America/Nuuk",
        "Pacific/Kanton",
      ].filter(isTimeZone),
    ),
  ].sort((left, right) =>
    left === "UTC" ? -1 : right === "UTC" ? 1 : left.localeCompare(right),
  );
}
export const preferencesSchema = z
  .strictObject({
    dateFormat: z.enum(dateFormatOptions.map((option) => option.id)),
    timeFormat: z.enum(timeFormatOptions.map((option) => option.id)),
    timeZone: z
      .string()
      .min(1)
      .max(100)
      .refine(isTimeZone, "Choose a valid time zone"),
  })
  .describe(
    "Preferences default to day-short-month-year, 24-hour and UTC. The timezone controls timestamp display, daily activity grouping and goal dates. Date-only records and stored timestamps remain unchanged.",
  );
export const profileSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
});
export const accountSchema = profileSchema.extend({
  email: z.email(),
  preferences: preferencesSchema,
});
export type Account = z.infer<typeof accountSchema>;
export const accountOperations = [
  {
    name: "update_browser_profile",
    method: "PATCH",
    path: "/auth/profile",
    status: "200",
    input: profileSchema,
    output: accountSchema,
    description:
      "Update the root account display name using a browser session. Email and password remain environment-managed. Health records are unaffected.",
  },
  {
    name: "update_browser_preferences",
    method: "PUT",
    path: "/auth/preferences",
    status: "200",
    input: preferencesSchema,
    output: accountSchema,
    description:
      "Save date format, time format and display time zone for the root account using a browser session. Recorded dates, daily summary boundaries and goal effective dates remain unchanged.",
  },
] as const;
