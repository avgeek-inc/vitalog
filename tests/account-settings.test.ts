import { describe, expect, it } from "vitest";
import {
  profileSchema,
  preferencesSchema,
  dateFormatOptions,
  timeFormatOptions,
  defaultDateTimePreferences,
  availableTimeZones,
} from "../src/auth/account-contracts.js";
import { formatDateTime } from "../apps/web/src/lib/date-time.js";

describe("account settings", () => {
  it("uses the common display preference IDs and defaults", () => {
    expect(dateFormatOptions.map(({ id }) => id)).toEqual([
      "day-short-month-year",
      "short-month-day-year",
      "year-month-day",
      "day-month-year",
      "month-day-year",
    ]);
    expect(timeFormatOptions.map(({ id }) => id)).toEqual([
      "24-hour",
      "12-hour",
      "24-hour-seconds",
      "12-hour-seconds",
    ]);
    expect(defaultDateTimePreferences).toEqual({
      dateFormat: "day-short-month-year",
      timeFormat: "24-hour",
      timeZone: "UTC",
    });
    expect(preferencesSchema.parse(defaultDateTimePreferences)).toEqual(
      defaultDateTimePreferences,
    );
    expect(availableTimeZones()[0]).toBe("UTC");
    expect(availableTimeZones()).toContain("Asia/Kolkata");
  });
  it.each(
    dateFormatOptions.flatMap((date) =>
      timeFormatOptions.map((time) => ({ date, time })),
    ),
  )(
    "formats and validates common date/time choices $date.id and $time.id",
    ({ date, time }) => {
      const preferences = preferencesSchema.parse({
        dateFormat: date.id,
        timeFormat: time.id,
        timeZone: "UTC",
      });
      expect(formatDateTime("2026-09-16T14:30:45Z", preferences)).toEqual({
        date: date.label,
        time: time.label,
        dateTime: `${time.label}, ${date.label}`,
      });
    },
  );
  it("validates a display name without accepting credential changes", () => {
    expect(profileSchema.parse({ name: "  Praveen Thirumurugan  " })).toEqual({
      name: "Praveen Thirumurugan",
    });
    for (const input of [
      { name: " " },
      { name: "n".repeat(121) },
      { name: "Name", email: "new@example.test" },
      { name: "Name", password: "password" },
    ])
      expect(profileSchema.safeParse(input).success).toBe(false);
  });
  it("accepts supported formats and IANA zones, rejecting offsets and unknown fields", () => {
    const preferences = {
      dateFormat: "day-month-year",
      timeFormat: "24-hour",
      timeZone: "Asia/Kolkata",
    };
    expect(preferencesSchema.parse(preferences)).toEqual(preferences);
    for (const input of [
      { ...preferences, dateFormat: "custom" },
      { ...preferences, timeFormat: "custom" },
      { ...preferences, timeZone: "+05:30" },
      { ...preferences, timeZone: "Not/AZone" },
      { ...preferences, email: "new@example.test" },
    ])
      expect(preferencesSchema.safeParse(input).success).toBe(false);
  });
  it("formats instants in the saved zone and preserves calendar-only log dates", () => {
    const preferences = {
      dateFormat: "year-month-day",
      timeFormat: "24-hour-seconds",
      timeZone: "America/New_York",
    } as const;
    expect(formatDateTime("2026-10-07T01:00:05Z", preferences)).toEqual({
      date: "2026-10-06",
      time: "21:00:05",
      dateTime: "21:00:05, 2026-10-06",
    });
    expect(formatDateTime("2026-10-07", preferences)).toEqual({
      date: "2026-10-07",
      time: null,
      dateTime: null,
    });
    expect(formatDateTime("0001-01-01", preferences).date).toBe("0001-01-01");
    expect(() => formatDateTime("2026-02-30", preferences)).toThrow(RangeError);
    expect(
      formatDateTime("2026-10-07T04:00:05Z", {
        ...preferences,
        timeFormat: "12-hour-seconds",
      }).time,
    ).toBe("12:00:05 AM");
    expect(formatDateTime("2026-11-01T05:30:00Z", preferences).time).toBe(
      "01:30:00",
    );
    expect(formatDateTime("2026-11-01T06:30:00Z", preferences).time).toBe(
      "01:30:00",
    );
  });
});
