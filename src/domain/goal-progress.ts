import { Decimal } from "decimal.js";
import type { Goal } from "../registry/goals.js";
import { dailySummary, numericProjection, overlaps, point } from "./summary.js";
import {
  object,
  usable,
  valueKindAt,
  type Data,
  type HealthRecord,
} from "./types.js";

type Observation = {
  value: Decimal | null;
  date: string | null;
  ids: string[];
  basis: string;
  coverage: "reported_daily_total" | "partial" | "observation" | "unknown";
  warnings: string[];
};
const decimal = (value: unknown) =>
  typeof value === "number" || typeof value === "string"
    ? new Decimal(value)
    : null;
export function weightValue(record: HealthRecord): Decimal | null {
  if (
    record.record_type !== "measurement" ||
    record.data.kind !== "scalar" ||
    record.data.metric_key !== "weight" ||
    !usable(record, "/value") ||
    !usable(record, "/unit") ||
    !usable(record, "/comparator") ||
    !usable(record, "/value/value") ||
    !usable(record, "/value/unit") ||
    !usable(record, "/value/comparator")
  )
    return null;
  const supplied =
    typeof record.data.value === "object"
      ? object(record.data.value).value
      : record.data.value;
  if (
    (typeof supplied !== "number" && typeof supplied !== "string") ||
    (typeof supplied === "number" && !Number.isFinite(supplied)) ||
    (typeof supplied === "string" &&
      !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(supplied))
  )
    return null;
  const value = point(record.data.value, record.data.comparator);
  const unit = object(record.data.value).unit ?? record.data.unit;
  if (
    !value?.isFinite() ||
    !value.isPositive() ||
    !["kg", "lb"].includes(String(unit))
  )
    return null;
  return unit === "lb" ? value.mul("0.45359237") : value;
}
function fromSummary(summary: Data, date: string): Observation {
  const value = decimal(summary.exact_decimal ?? summary.value);
  return {
    value,
    date: value ? date : null,
    ids: (summary.source_ids ?? []) as string[],
    basis: String(summary.basis ?? "missing"),
    coverage: value
      ? summary.basis === "reported_daily_total"
        ? "reported_daily_total"
        : "partial"
      : "unknown",
    warnings: [
      ...((summary.warnings ?? []) as string[]),
      ...(Number(summary.qualified_count ?? 0)
        ? ["qualified_values_excluded"]
        : []),
      ...(Number(summary.missing_count ?? 0) ? ["missing_values"] : []),
      ...(Number(summary.estimated_count ?? 0) ? ["includes_estimates"] : []),
    ],
  };
}
function observed(
  goal: Goal,
  daily: Data,
  records: HealthRecord[],
  weight: HealthRecord | undefined,
  date: string,
): Observation {
  if (goal.metric === "measurement:weight") {
    const value = weight ? weightValue(weight) : null;
    return {
      value,
      date: value ? weight!.occurred_on : null,
      ids: value ? [weight!.id] : [],
      basis: "latest_usable_weight",
      coverage: value ? "observation" : "unknown",
      warnings:
        weight && valueKindAt(weight, "/value") === "estimated"
          ? ["includes_estimates"]
          : [],
    };
  }
  if (goal.metric.startsWith("nutrient:")) {
    const key = goal.metric.split(":")[1]!;
    const nutrition = object(daily.nutrition);
    return fromSummary(
      object(
        key === "energy_kcal"
          ? nutrition.energy
          : object(nutrition.nutrients)[key],
      ),
      date,
    );
  }
  if (goal.metric === "hydration:water_ml")
    return fromSummary(object(object(daily.hydration).water_ml), date);
  const activity = object(daily.activity);
  const reported = object(activity.reported_daily_totals);
  const values = object(reported.values);
  const minutes = goal.metric === "activity:exercise_minutes";
  const field = minutes ? "exercise_seconds" : "active_energy_kcal";
  const total = decimal(values[field]);
  if (total !== null) {
    const source = records.find((record) => record.id === reported.source_id);
    return {
      value: minutes ? total.div(60) : total,
      date,
      ids: [String(reported.source_id)],
      basis: "reported_daily_total",
      coverage: "reported_daily_total",
      warnings:
        source && valueKindAt(source, `/daily_totals/${field}`) === "estimated"
          ? ["includes_estimates"]
          : [],
    };
  }
  const workouts = records.filter(
    (record) =>
      record.record_type === "activity" &&
      record.data.entry_kind === "workout" &&
      usable(record, minutes ? "/exercise_seconds" : "/energy_kcal") &&
      typeof record.data[minutes ? "exercise_seconds" : "energy_kcal"] ===
        "number" &&
      (minutes ||
        (record.data.energy_basis === "active" &&
          usable(record, "/energy_basis"))),
  );
  if (
    workouts.some((a, index) =>
      workouts.slice(index + 1).some((b) => overlaps(a, b)),
    )
  )
    return {
      value: null,
      date: null,
      ids: [],
      basis: "overlapping_workouts",
      coverage: "unknown",
      warnings: ["unresolved_workout_overlap"],
    };
  const subtotals = object(activity.workout_subtotals);
  const summary = object(
    minutes ? subtotals.exercise_seconds : object(subtotals.energy_kcal).active,
  );
  const result = fromSummary(
    {
      ...summary,
      basis: "known_workout_subtotal",
      estimated_count: workouts.filter(
        (record) =>
          valueKindAt(
            record,
            minutes ? "/exercise_seconds" : "/energy_kcal",
          ) === "estimated",
      ).length,
    },
    date,
  );
  if (minutes && result.value) result.value = result.value.div(60);
  return result;
}
export function goalProgress(
  goals: Goal[],
  records: HealthRecord[],
  weight: HealthRecord | undefined,
  date: string,
  timezone: string,
): Data[] {
  const daily = dailySummary(records, date, timezone, [
    "nutrition",
    "hydration",
    "activity",
  ]);
  return goals.map((goal) => {
    const observation = observed(goal, daily, records, weight, date);
    const actual = observation.value;
    const target = new Decimal(goal.target);
    let ratio: Decimal | null = null;
    let remaining: Decimal | null = null;
    let over: Decimal | null = null;
    let status = "unknown";
    if (actual !== null) {
      if (goal.direction === "target") {
        const baseline = new Decimal(goal.baseline!);
        ratio = baseline.eq(target)
          ? new Decimal(actual.eq(target) ? 1 : 0)
          : actual.minus(baseline).div(target.minus(baseline));
        status = ratio.gte(1) ? "met" : "in_progress";
        remaining =
          status === "met" ? new Decimal(0) : target.minus(actual).abs();
        over = new Decimal(0);
      } else {
        ratio = actual.div(target);
        remaining = Decimal.max(0, target.minus(actual));
        over =
          goal.direction === "maximum"
            ? Decimal.max(0, actual.minus(target))
            : new Decimal(0);
        status =
          goal.direction === "minimum"
            ? ratio.gte(1)
              ? "met"
              : "in_progress"
            : ratio.gt(1)
              ? "over_limit"
              : observation.coverage === "reported_daily_total" &&
                  !observation.warnings.some((warning) =>
                    ["missing_values", "qualified_values_excluded"].includes(
                      warning,
                    ),
                  )
                ? "within_limit"
                : "below_limit";
      }
    }
    return {
      goal,
      actual: actual === null ? null : numericProjection(actual),
      observed_on: observation.date,
      source_ids: observation.ids,
      basis: observation.basis,
      coverage: observation.coverage,
      status,
      ratio:
        ratio === null ? null : numericProjection(ratio.toDecimalPlaces(8)),
      progress_percent:
        ratio === null
          ? null
          : Decimal.max(0, Decimal.min(1, ratio))
              .mul(100)
              .toDecimalPlaces(2)
              .toNumber(),
      remaining: remaining === null ? null : numericProjection(remaining),
      over_by: over === null ? null : numericProjection(over),
      warnings: [
        ...new Set([
          ...observation.warnings,
          ...(observation.coverage === "partial" ? ["partial_day"] : []),
        ]),
      ],
    };
  });
}
