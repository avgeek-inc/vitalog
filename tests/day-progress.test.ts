import { describe, expect, it } from "vitest";
import { dayProgressPercent } from "../apps/web/src/lib/day-progress.js";

describe("daily progress marker", () => {
  it("uses the account timezone's local midnight", () => {
    expect(
      dayProgressPercent(
        "2026-10-07",
        "Asia/Kolkata",
        Date.parse("2026-10-07T06:30:00Z"),
      ),
    ).toBe(50);
  });

  it("only marks the day that is currently in progress", () => {
    const now = Date.parse("2026-10-07T06:30:00Z");
    expect(dayProgressPercent("2026-10-06", "Asia/Kolkata", now)).toBeNull();
    expect(dayProgressPercent("2026-10-08", "Asia/Kolkata", now)).toBeNull();
  });

  it("starts at zero and removes the marker at the next local midnight", () => {
    const start = Date.parse("2026-10-06T18:30:00Z");
    expect(dayProgressPercent("2026-10-07", "Asia/Kolkata", start)).toBe(0);
    expect(
      dayProgressPercent("2026-10-07", "Asia/Kolkata", start - 1),
    ).toBeNull();
    expect(
      dayProgressPercent("2026-10-07", "Asia/Kolkata", start + 86_400_000),
    ).toBeNull();
  });

  it.each([
    ["2026-03-08", "2026-03-08T16:30:00Z"],
    ["2026-11-01", "2026-11-01T16:30:00Z"],
  ])("accounts for daylight saving on %s", (date, halfway) => {
    expect(
      dayProgressPercent(date, "America/New_York", Date.parse(halfway)),
    ).toBe(50);
  });
});
