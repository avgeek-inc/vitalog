import { describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { goalProgress } from "../src/domain/goal-progress.js";
import {
  goalMetrics,
  goalProgressSchema,
  type Goal,
} from "../src/registry/goals.js";
import { operationByName } from "../src/registry/operations.js";
import { normalizeInput } from "../src/domain/validation.js";
import { record, fixtureDate, base } from "./fixtures.js";
import type { HealthRecord, Data } from "../src/domain/types.js";

function goal(
  metric: string,
  target: number,
  baseline: number | null = null,
): Goal {
  const {
    label: _label,
    accepted_units: _units,
    ...definition
  } = goalMetrics.find((item) => item.metric === metric)!;
  return {
    id: randomUUID(),
    ...definition,
    version: 1,
    baseline,
    target,
    status: "active",
    effective_on: fixtureDate,
    created_at: "2026-09-10T00:00:00Z",
    updated_at: "2026-09-10T00:00:00Z",
  };
}
function progress(
  metric: string,
  target: number,
  records: HealthRecord[] = [],
  baseline: number | null = null,
  weight?: HealthRecord,
): Data {
  const result = goalProgress(
    [goal(metric, target, baseline)],
    records,
    weight,
    fixtureDate,
    "Asia/Kolkata",
  )[0]!;
  goalProgressSchema.parse(result);
  return result;
}
const nutrition = (data: Data) =>
  record("nutrition", { entry_kind: "intake", ...data });
const workout = (data: Data, override: Partial<HealthRecord> = {}) =>
  record(
    "activity",
    { entry_kind: "workout", activity_type: "walking", ...data },
    override,
  );
describe("Goal progress preserves observation semantics", () => {
  for (const metric of goalMetrics)
    test(`${metric.metric}: missing values stay unknown`, () => {
      expect(
        progress(
          metric.metric,
          100,
          [],
          metric.direction === "target" ? 120 : null,
        ),
      ).toMatchObject({
        actual: null,
        progress_percent: null,
        ratio: null,
        remaining: null,
        status: "unknown",
      });
    });
  test("Limits show utilization and overage without claiming partial days are complete", () => {
    expect(
      progress("nutrient:energy_kcal", 2000, [
        nutrition({ nutrients: { energy_kcal: 1500 } }),
      ]),
    ).toMatchObject({
      actual: 1500,
      progress_percent: 75,
      remaining: 500,
      status: "below_limit",
      warnings: ["partial_day"],
    });
    expect(
      progress("nutrient:energy_kcal", 2000, [
        nutrition({ nutrients: { energy_kcal: 2400 } }),
      ]),
    ).toMatchObject({
      ratio: 1.2,
      progress_percent: 100,
      over_by: 400,
      status: "over_limit",
    });
  });
  test("Daily totals supersede intakes, including explicit zero", () => {
    const records = [
      nutrition({ nutrients: { protein_g: 80 } }),
      nutrition({ entry_kind: "daily_total", nutrients: { protein_g: 0 } }),
    ];
    expect(progress("nutrient:protein_g", 100, records)).toMatchObject({
      actual: 0,
      progress_percent: 0,
      status: "within_limit",
      source_ids: [records[1]!.id],
    });
  });
  test("Fiber limits use the logged daily total and retain unknown values", () => {
    expect(
      progress("nutrient:fiber_g", 30, [
        nutrition({ nutrients: { fiber_g: 18 } }),
      ]),
    ).toMatchObject({
      actual: 18,
      progress_percent: 60,
      remaining: 12,
      status: "below_limit",
    });
    const total = nutrition({
      entry_kind: "daily_total",
      nutrients: { fiber_g: 35 },
    });
    expect(
      progress("nutrient:fiber_g", 30, [
        nutrition({ nutrients: { fiber_g: 18 } }),
        total,
      ]),
    ).toMatchObject({
      actual: 35,
      progress_percent: 100,
      over_by: 5,
      status: "over_limit",
      source_ids: [total.id],
    });
    expect(
      progress("nutrient:fiber_g", 30, [
        nutrition({ nutrients: { fiber_g: null } }),
      ]).actual,
    ).toBeNull();
  });
  test("Energy conversion uses the shared kcal summary", () => {
    expect(
      progress("nutrient:energy_kcal", 2000, [
        nutrition({ nutrients: { energy_kj: 4184 } }),
      ]),
    ).toMatchObject({ actual: 1000, progress_percent: 50 });
  });
  test("Conflicting energy, qualified values and incompatible definitions stay unknown", () => {
    for (const records of [
      [nutrition({ nutrients: { energy_kcal: 1000, energy_kj: 200 } })],
      [
        nutrition({
          nutrients: { energy_kcal: 100 },
          nutrient_qualifiers: {
            energy_kcal: { kind: "bound", comparator: "lt" },
          },
        }),
      ],
    ])
      expect(progress("nutrient:energy_kcal", 2000, records).actual).toBeNull();
    expect(
      progress("nutrient:carbohydrate_g", 200, [
        nutrition({
          nutrients: { carbohydrate_g: 40 },
          carbohydrate_definition: "total",
        }),
        nutrition({
          nutrients: { carbohydrate_g: 40 },
          carbohydrate_definition: "available",
        }),
      ]).actual,
    ).toBeNull();
  });
  test("Water uses water intake only and target completion can exceed 100%", () => {
    const records = [
      record("hydration", {
        entry_kind: "intake",
        drink_type: "water",
        volume_ml: 3000,
      }),
      record("hydration", {
        entry_kind: "intake",
        drink_type: "coffee",
        volume_ml: 200,
      }),
    ];
    expect(progress("hydration:water_ml", 2500, records)).toMatchObject({
      actual: 3000,
      ratio: 1.2,
      progress_percent: 100,
      remaining: 0,
      status: "met",
    });
  });
  test("Daily water totals are not added to individual drinks", () => {
    expect(
      progress("hydration:water_ml", 2500, [
        record("hydration", {
          entry_kind: "intake",
          drink_type: "water",
          volume_ml: 500,
        }),
        record("hydration", { entry_kind: "daily_total", water_ml: 1000 }),
      ]),
    ).toMatchObject({ actual: 1000, progress_percent: 40 });
  });
  test("Gross calories and elapsed/moving time are not active calories or active minutes", () => {
    const records = [
      workout({
        energy_kcal: 300,
        energy_basis: "gross",
        elapsed_seconds: 3600,
        moving_seconds: 3000,
      }),
    ];
    expect(
      progress("activity:active_energy_kcal", 400, records).actual,
    ).toBeNull();
    expect(
      progress("activity:exercise_minutes", 30, records).actual,
    ).toBeNull();
  });
  test("Reported exercise duration converts seconds to minutes and daily totals win", () => {
    const records = [
      workout({
        energy_kcal: 300,
        energy_basis: "active",
        exercise_seconds: 2700,
      }),
      record("activity", {
        entry_kind: "daily_total",
        daily_totals: { active_energy_kcal: 400, exercise_seconds: 1800 },
      }),
    ];
    expect(progress("activity:active_energy_kcal", 500, records)).toMatchObject(
      { actual: 400, progress_percent: 80, source_ids: [records[1]!.id] },
    );
    expect(progress("activity:exercise_minutes", 30, records)).toMatchObject({
      actual: 30,
      status: "met",
    });
    expect(
      progress("activity:exercise_minutes", 60, [records[0]!]),
    ).toMatchObject({ actual: 45, progress_percent: 75 });
  });
  test("Overlapping workouts cannot silently double count exercise progress", () => {
    const records = [
      workout(
        { exercise_seconds: 1200 },
        {
          occurred_at: "2026-09-10T01:00:00Z",
          ended_at: "2026-09-10T01:30:00Z",
        },
      ),
      workout(
        { exercise_seconds: 1200 },
        {
          occurred_at: "2026-09-10T01:15:00Z",
          ended_at: "2026-09-10T01:45:00Z",
        },
      ),
    ];
    expect(progress("activity:exercise_minutes", 30, records)).toMatchObject({
      actual: null,
      warnings: ["unresolved_workout_overlap"],
    });
  });
  test("Invalid records and field overrides are excluded", () => {
    const records = [
      record(
        "hydration",
        { entry_kind: "intake", drink_type: "water", volume_ml: 1000 },
        { validity: "invalid" },
      ),
      workout(
        { energy_kcal: 200, energy_basis: "active" },
        {
          provenance: {
            ...base.provenance,
            field_overrides: { "/energy_kcal": { validity: "suspect" } },
          },
        },
      ),
    ];
    expect(progress("hydration:water_ml", 2500, records).actual).toBeNull();
    expect(
      progress("activity:active_energy_kcal", 300, records).actual,
    ).toBeNull();
  });
  test.each([
    [80, 70, 75, 50, "in_progress"],
    [60, 70, 65, 50, "in_progress"],
    [80, 70, 68, 100, "met"],
    [60, 70, 72, 100, "met"],
    [80, 70, 85, 0, "in_progress"],
    [70, 70, 70, 100, "met"],
  ])(
    "Weight baseline %s, target %s, observation %s",
    (baseline, target, value, percent, status) => {
      const weight = record("measurement", {
        kind: "scalar",
        metric_key: "weight",
        value,
        unit: "kg",
      });
      expect(
        progress("measurement:weight", target, [], baseline, weight),
      ).toMatchObject({ actual: value, progress_percent: percent, status });
    },
  );
  test("Weight pounds normalize to kg; qualified or unsupported units stay unknown", () => {
    const weight = record("measurement", {
      kind: "scalar",
      metric_key: "weight",
      value: 150,
      unit: "lb",
    });
    expect(
      progress("measurement:weight", 65, [], 75, weight).actual,
    ).toBeCloseTo(68.0388555);
    for (const data of [
      { ...weight.data, unit: "stone" },
      { ...weight.data, comparator: "lt" },
    ])
      expect(
        progress("measurement:weight", 65, [], 75, { ...weight, data }).actual,
      ).toBeNull();
  });
  test("Invalid energy bases and nested weight fields cannot produce numeric progress", () => {
    const activity = workout(
      { energy_kcal: 200, energy_basis: "active" },
      {
        provenance: {
          ...base.provenance,
          field_overrides: { "/energy_basis": { validity: "invalid" } },
        },
      },
    );
    expect(
      progress("activity:active_energy_kcal", 400, [activity]).actual,
    ).toBeNull();
    const weight = record(
      "measurement",
      {
        kind: "scalar",
        metric_key: "weight",
        value: { kind: "quantity", value: 75, unit: "kg" },
        unit: "kg",
      },
      {
        provenance: {
          ...base.provenance,
          field_overrides: { "/value/value": { validity: "invalid" } },
        },
      },
    );
    expect(
      progress("measurement:weight", 70, [], 80, weight).actual,
    ).toBeNull();
    for (const value of ["unreadable", "Infinity", Infinity])
      expect(
        progress(
          "measurement:weight",
          70,
          [],
          80,
          record("measurement", {
            kind: "scalar",
            metric_key: "weight",
            value,
            unit: "kg",
          }),
        ).actual,
      ).toBeNull();
  });
  test("Inputs reject invalid metrics, targets and custom comparison rules", () => {
    const schema = operationByName.get("health_set_goal")!.input;
    const input = {
      idempotency_key: "goal",
      metric: "hydration:water_ml",
      target: 2500,
      expected_version: 0,
    };
    for (const extra of [
      { target: 0 },
      { target: -1 },
      { target: Infinity },
      { metric: "unsupported" },
      { direction: "maximum" },
      { expected_version: -1 },
    ])
      expect(schema.safeParse({ ...input, ...extra }).success).toBe(false);
  });
  test("Exercise seconds is accepted explicitly but cannot exceed elapsed seconds", () => {
    const data = {
      entry_kind: "workout",
      activity_type: "walking",
      elapsed_seconds: 3600,
      exercise_seconds: 2700,
    };
    expect(
      normalizeInput("activity", { ...base, data }, "Asia/Kolkata").data
        .exercise_seconds,
    ).toBe(2700);
    expect(() =>
      normalizeInput(
        "activity",
        { ...base, data: { ...data, exercise_seconds: 3601 } },
        "Asia/Kolkata",
      ),
    ).toThrow();
  });
});
