import { describe, expect, test } from "vitest";
import { dailySummary } from "../src/domain/summary.js";
import { goalProgress } from "../src/domain/goal-progress.js";
import { record } from "./fixtures.js";
import {
  activityActual,
  exactWeight,
  logView,
  sortWeightRecords,
  type HealthRecord,
} from "../apps/web/src/lib/health.js";
import type { Goal } from "../src/registry/goals.js";

describe("Read-only health presentation", () => {
  test("Weight selection matches the API's event-time ordering within a date", () => {
    const timed = record(
      "measurement",
      { kind: "scalar", metric_key: "weight", value: "73.8", unit: "kg" },
      { occurred_at: "2026-09-10T06:00:00Z" },
    );
    const dated = {
      ...timed,
      id: "date-only",
      occurred_at: null,
      recorded_at: "2026-09-10T20:00:00Z",
    };
    expect(sortWeightRecords([dated, timed])[0]!.id).toBe(timed.id);
  });
  test("Unknown activity stays unknown; explicit zero and supplied exercise minutes are preserved", () => {
    const empty = dailySummary([], "2026-10-05", "Asia/Kolkata");
    expect(activityActual(empty, [], false)).toBeNull();
    expect(activityActual(empty, [], true)).toBeNull();
    const daily = record("activity", {
      entry_kind: "daily_total",
      daily_totals: { active_energy_kcal: 0, exercise_seconds: 900 },
    });
    const summary = dailySummary([daily], daily.occurred_on!, "Asia/Kolkata");
    expect(activityActual(summary, [daily], false)).toBe(0);
    expect(activityActual(summary, [daily], true)).toBe(15);
  });
  test("Activity follows the goal calculation with or without a configured target", () => {
    const date = "2026-10-05";
    const workouts = [
      record("activity", {
        entry_kind: "workout",
        activity_type: "walking",
        exercise_seconds: 900,
        elapsed_seconds: 1800,
        energy_kcal: 100,
        energy_basis: "active",
      }),
    ];
    for (const workout of workouts) workout.occurred_on = date;
    const base: Goal = {
      id: "00000000-0000-4000-8000-000000000001",
      metric: "activity:active_energy_kcal",
      unit: "kcal",
      baseline: null,
      target: 300,
      direction: "minimum",
      period: "daily",
      version: 1,
      status: "active",
      effective_on: date,
      created_at: date + "T00:00:00Z",
      updated_at: date + "T00:00:00Z",
    };
    for (const overlap of [false, true]) {
      const records = [...workouts];
      if (overlap) {
        records[0] = {
          ...records[0]!,
          occurred_at: date + "T06:00:00Z",
          ended_at: date + "T06:30:00Z",
        };
        records.push({
          ...records[0]!,
          id: "00000000-0000-4000-8000-000000000002",
          occurred_at: date + "T06:15:00Z",
          ended_at: date + "T06:45:00Z",
        });
      }
      const summary = dailySummary(records, date, "Asia/Kolkata");
      const progress = goalProgress(
        [base, { ...base, metric: "activity:exercise_minutes", unit: "min" }],
        records,
        undefined,
        date,
        "Asia/Kolkata",
      );
      expect(activityActual(summary, records, false)).toBe(progress[0]!.actual);
      expect(activityActual(summary, records, true)).toBe(progress[1]!.actual);
    }
  });
  test("A qualified or invalid weight cannot become current weight, while lb converts to kg", () => {
    const weight = record("measurement", {
      kind: "scalar",
      metric_key: "weight",
      value: "160",
      unit: "lb",
    });
    expect(exactWeight(weight)).toBeCloseTo(72.5747792);
    expect(
      exactWeight({ ...weight, data: { ...weight.data, comparator: "gt" } }),
    ).toBeNull();
    expect(
      exactWeight({
        ...weight,
        provenance: {
          ...weight.provenance,
          field_overrides: { "/value": { validity: "invalid" } },
        },
      }),
    ).toBeNull();
    expect(exactWeight({ ...weight, validity: "suspect" })).toBeNull();
  });
  test("Log energy qualifications are visible and date-only records do not invent an event time", () => {
    const meal = record("nutrition", {
      entry_kind: "intake",
      label: "Lunch",
      nutrients: { energy_kcal: 500, fiber_g: 8 },
      nutrient_qualifiers: { energy_kcal: { kind: "bound", comparator: "lt" } },
    });
    const view = logView(meal, "Asia/Kolkata");
    expect(view.metric).toBe("<500 kcal");
    expect(view.time).toBeNull();
    expect(view.details).toContainEqual({ label: "Fiber", value: "8 g" });
    expect(
      logView({ ...meal, occurred_at: "2026-10-05T05:00:00Z" }, "Asia/Kolkata")
        .time,
    ).toBe("10:30 AM");
  });
  test("Numeric mood ratings remain separate from categorical mood", () => {
    const checkin = record("checkin", {
      ratings: {
        mood: {
          value: 8,
          upper: 10,
          lower: 0,
          scale: "custom",
          meaning: "User supplied",
        },
      },
    });
    expect(logView(checkin as HealthRecord, "Asia/Kolkata").metric).toBe("—");
    expect(
      logView(
        { ...checkin, data: { ...checkin.data, mood: "great" } },
        "Asia/Kolkata",
      ).metric,
    ).toBe("Great");
  });
});
