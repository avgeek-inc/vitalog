import { describe, expect, test } from "vitest";
import { recordCalendarDate } from "../src/domain/record-date.js";
import { dailySummary } from "../src/domain/summary.js";
import { record } from "./fixtures.js";

const intake = record(
  "hydration",
  { entry_kind: "intake", volume_ml: 250, drink_type: "water" },
  {
    occurred_on: "2026-09-09",
    occurred_at: "2026-09-09T23:30:00Z",
    timezone: "UTC",
    time_precision: "instant",
    date_basis: "event_date",
  },
);

describe("account timezone calendar days", () => {
  test("regroups an instant without changing the original record", () => {
    expect(recordCalendarDate(intake, "UTC")).toBe("2026-09-09");
    expect(recordCalendarDate(intake, "Asia/Kolkata")).toBe("2026-09-10");
    expect(recordCalendarDate(intake, "America/Los_Angeles")).toBe(
      "2026-09-09",
    );
    expect(intake.occurred_on).toBe("2026-09-09");
    expect(intake.occurred_at).toBe("2026-09-09T23:30:00Z");
  });
  test("daily summaries use the selected zone and keep date-only observations fixed", () => {
    const dated = record(
      "hydration",
      { entry_kind: "intake", volume_ml: 500, drink_type: "water" },
      { occurred_on: "2026-09-10" },
    );
    const utc = dailySummary([intake, dated], "2026-09-10", "UTC");
    const india = dailySummary([intake, dated], "2026-09-10", "Asia/Kolkata");
    expect(utc.hydration).toMatchObject({ water_ml: { exact_value: 500 } });
    expect(india.hydration).toMatchObject({ water_ml: { exact_value: 750 } });
    expect(recordCalendarDate(dated, "Pacific/Honolulu")).toBe("2026-09-10");
  });
  test("sleep sessions follow the wake instant", () => {
    const sleep = {
      ...intake,
      occurred_at: "2026-09-09T16:00:00Z",
      ended_at: "2026-09-09T23:30:00Z",
      date_basis: "wake_date",
    };
    expect(recordCalendarDate(sleep, "Asia/Kolkata")).toBe("2026-09-10");
    expect(recordCalendarDate(sleep, "UTC")).toBe("2026-09-09");
  });
  test.each([
    "2026-03-08T06:30:00Z",
    "2026-03-08T07:30:00Z",
    "2026-11-01T05:30:00Z",
    "2026-11-01T06:30:00Z",
  ])("handles daylight-saving offset changes at %s", (instant) => {
    expect(
      recordCalendarDate(
        { ...intake, occurred_at: instant },
        "America/New_York",
      ),
    ).toBe(instant.slice(0, 10));
  });
});
