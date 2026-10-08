import { z } from "zod";
import * as p from "./primitives.js";
import { CATALOG_VERSION } from "./definitions.js";
import type { Operation } from "./operations.js";

export const goalMetrics = [
  {
    metric: "measurement:weight",
    label: "Weight",
    unit: "kg",
    accepted_units: ["kg", "lb"],
    period: "ongoing",
    direction: "target",
  },
  {
    metric: "nutrient:energy_kcal",
    label: "Calories",
    unit: "kcal",
    accepted_units: ["kcal"],
    period: "daily",
    direction: "maximum",
  },
  {
    metric: "nutrient:protein_g",
    label: "Protein",
    unit: "g",
    accepted_units: ["g"],
    period: "daily",
    direction: "maximum",
  },
  {
    metric: "nutrient:carbohydrate_g",
    label: "Carbohydrates",
    unit: "g",
    accepted_units: ["g"],
    period: "daily",
    direction: "maximum",
  },
  {
    metric: "nutrient:fat_g",
    label: "Fat",
    unit: "g",
    accepted_units: ["g"],
    period: "daily",
    direction: "maximum",
  },
  {
    metric: "nutrient:fiber_g",
    label: "Fiber",
    unit: "g",
    accepted_units: ["g"],
    period: "daily",
    direction: "maximum",
  },
  {
    metric: "hydration:water_ml",
    label: "Water",
    unit: "mL",
    accepted_units: ["mL"],
    period: "daily",
    direction: "minimum",
  },
  {
    metric: "activity:active_energy_kcal",
    label: "Calories burned",
    unit: "kcal",
    accepted_units: ["kcal"],
    period: "daily",
    direction: "minimum",
  },
  {
    metric: "activity:exercise_minutes",
    label: "Active minutes",
    unit: "min",
    accepted_units: ["min"],
    period: "daily",
    direction: "minimum",
  },
] as const;
export const goalMetricKeys = goalMetrics.map((entry) => entry.metric);
export const goalMetric = z.enum(goalMetricKeys as [string, ...string[]]);
export const goalMetricByKey = new Map<string, (typeof goalMetrics)[number]>(
  goalMetrics.map((entry) => [entry.metric, entry]),
);
const positive = z.number().finite().positive().max(1e12);
const version = z.number().int().positive().max(2_147_483_647);
export const goalSchema = z.strictObject({
  id: z.uuid(),
  metric: goalMetric,
  version,
  period: z.enum(["daily", "ongoing"]),
  direction: z.enum(["maximum", "minimum", "target"]),
  target: positive,
  unit: p.text(20),
  baseline: positive.nullable(),
  status: z.enum(["active", "archived"]),
  effective_on: p.date,
  created_at: p.instant,
  updated_at: p.instant,
});
export type Goal = z.infer<typeof goalSchema>;
const metadata = { catalog_version: z.literal(CATALOG_VERSION) };
const numeric = z.union([z.number().finite(), p.text(10000)]).nullable();
export const goalProgressSchema = z.strictObject({
  goal: goalSchema,
  actual: numeric,
  observed_on: p.date.nullable(),
  source_ids: z.array(z.uuid()).max(1000),
  basis: p.text(100),
  coverage: z.enum([
    "reported_daily_total",
    "partial",
    "observation",
    "unknown",
  ]),
  status: z.enum([
    "unknown",
    "in_progress",
    "met",
    "over_limit",
    "within_limit",
    "below_limit",
  ]),
  ratio: numeric,
  progress_percent: z.number().min(0).max(100).nullable(),
  remaining: numeric,
  over_by: numeric,
  warnings: z.array(p.text(200)).max(100),
});
export function goalOperations(idempotencyKey: z.ZodString): Operation[] {
  return [
    {
      name: "health_get_goal_catalog",
      method: "GET",
      path: "/v1/goals/catalog",
      mutation: false,
      input: z.strictObject({}),
      output: z.strictObject({
        ...metadata,
        metrics: z
          .array(
            z.strictObject({
              metric: goalMetric,
              label: p.text(100),
              unit: p.text(20),
              accepted_units: z.array(p.text(20)).max(10),
              period: z.enum(["daily", "ongoing"]),
              direction: z.enum(["maximum", "minimum", "target"]),
            }),
          )
          .max(200),
      }),
      description:
        "Discover supported goal metrics, canonical units and fixed comparison rules. Goals are explicit user targets, separate from observed records.",
    },
    {
      name: "health_set_goal",
      method: "POST",
      path: "/v1/goals",
      mutation: true,
      input: z.strictObject({
        idempotency_key: idempotencyKey,
        metric: goalMetric,
        target: positive,
        unit: p.text(20).optional(),
        baseline: positive.optional(),
        expected_version: z.number().int().min(0).max(2_147_483_646),
      }),
      output: z.strictObject({
        ...metadata,
        goal: goalSchema,
        committed_version: version,
        idempotent_replay: z.boolean(),
      }),
      description:
        "Set or reactivate a user-supplied goal from today in the server timezone. Use expected_version=0 for a new metric, otherwise its current version. Weight requires an explicit baseline on creation; it is retained on edits unless supplied. No automatic recommendations.",
    },
    {
      name: "health_list_goals",
      method: "GET",
      path: "/v1/goals",
      mutation: false,
      input: z.strictObject({
        status: z.enum(["active", "archived", "all"]).optional(),
      }),
      output: z.strictObject({
        ...metadata,
        goals: z.array(goalSchema).max(200),
        returned_count: p.count,
      }),
      description:
        "List current goals, active by default. Use health_get_goal_progress for historical goals and observed progress on a particular date.",
    },
    {
      name: "health_get_goal",
      method: "GET",
      path: "/v1/goals/{id}",
      mutation: false,
      input: z.strictObject({
        id: z.uuid(),
        include_history: z.boolean().optional(),
        history_limit: z.number().int().min(1).max(100).optional(),
        history_before_version: version.optional(),
      }),
      output: z.strictObject({
        ...metadata,
        goal: goalSchema,
        history: z.array(goalSchema).max(100).optional(),
        history_has_more: z.boolean().optional(),
        history_next_version: version.nullable().optional(),
      }),
      description:
        "Read a goal and optionally a bounded page of its immutable revisions, newest first.",
    },
    {
      name: "health_archive_goal",
      method: "POST",
      path: "/v1/goals/{id}/archive",
      mutation: true,
      input: z.strictObject({
        id: z.uuid(),
        idempotency_key: idempotencyKey,
        expected_version: version,
      }),
      output: z.strictObject({
        ...metadata,
        goal: goalSchema,
        committed_version: version,
        idempotent_replay: z.boolean(),
      }),
      description:
        "Archive a goal from today with an expected version. Preserve history and previous-day progress. Reactivate with health_set_goal.",
    },
    {
      name: "health_get_goal_progress",
      method: "GET",
      path: "/v1/days/{date}/goal-progress",
      mutation: false,
      input: z.strictObject({ date: p.date }),
      output: z.strictObject({
        ...metadata,
        date: p.date,
        timezone: p.text(100),
        progress: z.array(goalProgressSchema).max(200),
      }),
      description:
        "Compare goals effective on a local date with qualified observed values. Unknown stays null. Nutrition uses limit utilization; water and exercise use target completion; weight uses an explicit baseline. Daily totals take precedence, gross calories are excluded, and elapsed time is never inferred as active minutes.",
    },
  ];
}
