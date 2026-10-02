import { z } from "zod";
import {
  analyteKeys,
  CATALOG_VERSION,
  measurementKeys,
  nutrientKeys,
  recordTypes,
  type RecordType,
} from "./definitions.js";
import {
  commonEnvelope,
  labResultInput,
  recordInputs,
  recordSchemas,
} from "./records.js";
import * as p from "./primitives.js";
import { catalogOutputSchema } from "./catalog-output.js";

export const idempotencyKey = p
  .text(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const sections = z
  .array(
    z.enum([
      "nutrition",
      "hydration",
      "activity",
      "sleep",
      "checkin",
      "intake",
      "measurement",
      "lab_result",
    ]),
  )
  .min(1)
  .max(8)
  .optional();
export const catalogInput = z.strictObject({
  category: z
    .enum([
      "overview",
      "nutrients",
      "lab_panels",
      "lab_analytes",
      "measurements",
      "record_schemas",
    ])
    .optional(),
  panel_key: p.text(100).optional(),
  group_key: p.text(100).optional(),
  field_path: p.pointer.optional(),
  key: p.text(100).optional(),
  query: p.text(100).optional(),
  include_schema: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: p.text(2000).optional(),
  catalog_version: p.text(50).optional(),
});
export const listInput = z.strictObject({
  record_types: z.array(z.enum(recordTypes)).min(1).max(8).optional(),
  start_date: p.date.optional(),
  end_date: p.date.optional(),
  include_undated: z.boolean().optional(),
  source_type: p.sourceType.optional(),
  source_description: p.text(200).optional(),
  validity: p.validity.optional(),
  status: z.enum(["active", "voided", "all"]).optional(),
  metric_key: z.enum(measurementKeys as [string, ...string[]]).optional(),
  analyte_key: z.enum(analyteKeys as [string, ...string[]]).optional(),
  custom_identity: p.text(100).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: p.text(2000).optional(),
});
export const metricKeys = [
  ...measurementKeys
    .filter((key) => key !== "blood_pressure")
    .map((key) => `measurement:${key}`),
  ...analyteKeys.map((key) => `lab:${key}`),
  ...nutrientKeys.map((key) => `nutrient:${key}`),
  "hydration:total_fluids_ml",
  "hydration:water_ml",
  "sleep:sleep_seconds",
  "activity:steps",
  "activity:distance_m",
  "activity:active_energy_kcal",
];
const trendInput = z.strictObject({
  metrics: z
    .array(z.enum(metricKeys as [string, ...string[]]))
    .min(1)
    .max(20),
  start_date: p.date,
  end_date: p.date,
  granularity: z.enum(["day", "week"]).optional(),
  include_preliminary: z.boolean().optional(),
  source_type: p.sourceType.optional(),
  specimen_type: p.specimenType.optional(),
  method_name: p.text(200).optional(),
  measurement_site: p.text(200).optional(),
  resting_state: z
    .enum(["resting", "exercise", "recovery", "sleep", "unknown"])
    .optional(),
});
const storedEnvelope = {
  id: z.uuid(),
  record_type: z.enum(recordTypes),
  version: z.number().int().positive(),
  occurred_on: p.date.nullable(),
  occurred_at: p.instant.nullable(),
  ended_at: p.instant.nullable(),
  timezone: p.text(100),
  time_precision: z.enum(["date", "instant", "period", "unknown"]),
  date_basis: z.enum([
    "reported_date",
    "event_date",
    "wake_date",
    "specimen_date",
    "report_date",
    "unknown",
  ]),
  recorded_at: p.instant,
  updated_at: p.instant,
  status: z.enum(["active", "voided"]),
  validity: p.validity,
  provenance: p.provenance,
};
const timeContext = z.strictObject({
  original_occurred_at: p.instant.nullable(),
  original_ended_at: p.instant.nullable(),
  supplied_timezone: p.text(100).nullable(),
});
const storedRecord = z.union([
  ...recordTypes.map((type) =>
    z.strictObject({
      ...storedEnvelope,
      record_type: z.literal(type),
      schema_version: z.literal(2),
      data: recordSchemas[type],
      time_context: timeContext,
    }),
  ),
  z.strictObject({
    ...storedEnvelope,
    schema_version: z.literal(1),
    data: z.record(p.text(100), z.json()),
    time_context: timeContext.optional(),
  }),
]);
const metadata = { catalog_version: z.literal(CATALOG_VERSION) };
const singleOutput = z.strictObject({
  ...metadata,
  record: storedRecord,
  warnings: z.array(p.text(200)),
  idempotent_replay: z.boolean(),
  committed_version: z.number().int().positive(),
});
const batchOutput = z.strictObject({
  ...metadata,
  records: z.array(storedRecord).min(1).max(100),
  warnings: z.array(p.text(200)),
  idempotent_replay: z.boolean(),
  committed_versions: z.array(z.number().int().positive()).max(100),
});
const pageOutput = z.strictObject({
  ...metadata,
  records: z.array(storedRecord).max(200),
  returned_count: p.count,
  has_more: z.boolean(),
  next_cursor: p.text(2000).nullable(),
});
const recordOutput = z.strictObject({
  ...metadata,
  record: storedRecord,
  history: z
    .array(
      z.strictObject({
        version: z.number().int().positive(),
        snapshot: storedRecord,
        changed_at: p.instant,
        reason: p.text(300),
      }),
    )
    .max(100)
    .optional(),
  history_has_more: z.boolean().optional(),
  history_next_version: p.count.nullable().optional(),
});
const sourceIds = z.array(z.uuid()).max(1000);
const computedDecimalText = p.text(10000).regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);
const computedSigned = p.signed.or(computedDecimalText);
const computedNonnegative = p.nonnegative.or(
  p.text(10000).regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/),
);
const numericRepresentation = {
  exact_value: computedSigned.nullable(),
  exact_decimal: p.text(10000).nullable(),
};
const summaryResult = z.strictObject({
  kind: z.enum(["exact", "bound", "interval", "unquantified"]),
  value: computedNonnegative.optional(),
  exact_decimal: p.text(10000).optional(),
  comparator: z.enum(["lt", "le", "gt", "ge"]).optional(),
  unit: p.text(80).optional(),
  lower: computedNonnegative.optional(),
  upper: computedNonnegative.optional(),
  lower_inclusive: z.boolean().optional(),
  upper_inclusive: z.boolean().optional(),
  original_value_text: p.text(200).optional(),
  reported_precision: p.count.max(15).optional(),
  reason: p.absentReason.optional(),
  explanation: p.text(300).optional(),
  value_decimal: p.text(10000).optional(),
  lower_decimal: p.text(10000).optional(),
  upper_decimal: p.text(10000).optional(),
});
const definitionBasis = z.strictObject({
  expression_basis: p.text(100),
  form: p.text(100),
  method: p.text(200),
  definition: p.text(300),
  definition_version: p.text(100),
  source_definition_reference: p.text(200),
  carbohydrate_definition: p.text(200).optional(),
  fiber_method: p.text(200).optional(),
  folate_basis: p.text(200).optional(),
  energy_method: p.text(100).optional(),
});
const intakeSubtotal = z.strictObject({
  definition_basis: definitionBasis,
  ...numericRepresentation,
  source_ids: sourceIds,
});
const qualifiedSource = z.strictObject({
  source_id: z.uuid(),
  result: summaryResult,
  provenance: p.provenance.optional(),
  definition_basis: definitionBasis.optional(),
});
const nutrientSummary = z.strictObject({
  effective_result: summaryResult.nullable(),
  ...numericRepresentation,
  basis: z.enum([
    "reported_daily_total",
    "known_intake_subtotal",
    "incompatible_definition",
  ]),
  definition_basis: definitionBasis.nullable(),
  source_ids: sourceIds,
  known_intake_subtotals: z.array(intakeSubtotal).max(1000),
  qualified_results: z.array(qualifiedSource).max(1000),
  qualified_count: p.count,
  missing_count: p.count,
  estimated_count: p.count,
  excluded_count: p.count,
  coverage: z.literal("only_supplied_fields"),
  reported_coverage: p.text(200).nullable(),
  energy_projection: z
    .strictObject({
      derived_from: z.literal("nutrition.energy"),
      canonical_unit: z.literal("kcal"),
      output_unit: z.enum(["kcal", "kJ"]),
      factor: p.text(100),
      stored_values_changed: z.literal(false),
    })
    .optional(),
  warnings: z.array(p.text(200)),
});
const energySummary = z.strictObject({
  effective_result: summaryResult.nullable(),
  ...numericRepresentation,
  basis: z.enum([
    "reported_daily_total",
    "known_intake_subtotal",
    "incompatible_definition",
  ]),
  unit: z.literal("kcal"),
  source_ids: sourceIds,
  definition_basis: definitionBasis.nullable(),
  known_intake_subtotal: z.strictObject({
    ...numericRepresentation,
    source_ids: sourceIds,
  }),
  known_intake_subtotals: z.array(intakeSubtotal).max(1000),
  qualified_results: z.array(qualifiedSource).max(1000),
  conflicting_source_ids: sourceIds,
  conversion_provenance: z.strictObject({
    kcal_per_kj: z.literal("1/4.184"),
    selection: z.literal("prefer_supplied_kcal_when_consistent"),
    consistency_tolerance: z.literal("max(1 kcal, 2% of supplied kcal)"),
    stored_values_changed: z.literal(false),
  }),
  qualified_count: p.count,
  missing_count: p.count,
  estimated_count: p.count,
  reported_coverage: p.text(200).nullable(),
  warnings: z.array(p.text(200)),
});
const nutritionSummaryOutput = z.strictObject({
  nutrients: z.partialRecord(
    z.enum(nutrientKeys as [string, ...string[]]),
    nutrientSummary,
  ),
  energy: energySummary.nullable(),
  overlap_warnings: z
    .array(
      z.strictObject({
        code: z.literal("non_additive_components"),
        keys: z.array(p.text(100)).max(30),
      }),
    )
    .max(30),
  record_count: p.count,
  source_ids: sourceIds,
  provenance: z
    .array(
      z.strictObject({
        source_id: z.uuid(),
        provenance: p.provenance,
        validity: p.validity,
      }),
    )
    .max(1000),
});
const fluidSummaryOutput = z.strictObject({
  ...numericRepresentation,
  basis: z.enum(["reported_daily_total", "known_intake_subtotal"]),
  known_intake_subtotal: z.strictObject(numericRepresentation),
  source_ids: sourceIds,
  missing_count: p.count,
  estimated_count: p.count,
  excluded_count: p.count,
  coverage: z.literal("tracked_oral_enteral_intake_only"),
  warnings: z.array(p.text(200)),
});
const hydrationSummaryOutput = z.strictObject({
  total_fluids_ml: fluidSummaryOutput,
  water_ml: fluidSummaryOutput,
  other_route_records: z
    .array(
      z.strictObject({ id: z.uuid(), route: z.enum(["other", "unknown"]) }),
    )
    .max(1000),
  source_ids: sourceIds,
  provenance: z
    .array(
      z.strictObject({
        source_id: z.uuid(),
        provenance: p.provenance,
        validity: p.validity,
      }),
    )
    .max(1000),
});
const numericSource = z.strictObject({
  ...numericRepresentation,
  source_ids: sourceIds,
});
const dailyActivityValues = z.strictObject({
  steps: p.count.optional(),
  distance_m: p.nonnegative.optional(),
  active_energy_kcal: p.nonnegative.optional(),
  resting_energy_kcal: p.nonnegative.optional(),
  total_energy_kcal: p.nonnegative.optional(),
  exercise_seconds: p.nonnegative.optional(),
  standing_seconds: p.nonnegative.optional(),
  sedentary_seconds: p.nonnegative.optional(),
  moderate_seconds: p.nonnegative.optional(),
  vigorous_seconds: p.nonnegative.optional(),
  light_seconds: p.nonnegative.optional(),
  definitions: p.text(300).optional(),
  coverage: p.coverage.optional(),
});
const activitySummaryOutput = z.strictObject({
  workout_subtotals: z.strictObject({
    elapsed_seconds: numericSource,
    distance_m: numericSource,
    steps: numericSource,
    energy_kcal: z.strictObject({
      active: numericSource,
      gross: numericSource,
      unknown: numericSource,
    }),
  }),
  reported_daily_totals: z
    .strictObject({
      source_id: z.uuid(),
      values: dailyActivityValues,
      provenance: p.provenance,
    })
    .nullable(),
  workouts: z
    .array(
      z.strictObject({
        source_id: z.uuid(),
        activity_type: p.text(100),
        data: recordSchemas.activity.options[0].partial(),
        provenance: p.provenance,
      }),
    )
    .max(1000),
  basis: z.enum([
    "reported_daily_total_separate_from_workouts",
    "known_workout_subtotal",
  ]),
  warnings: z.array(p.text(200)),
});
const sleepSummaryOutput = z.strictObject({
  sessions: z.array(storedRecord).max(1000),
  ...numericRepresentation,
  warnings: z.array(p.text(200)),
  basis: z.literal("supplied_sessions_only"),
  source_ids: sourceIds,
  missing_count: p.count,
  estimated_count: p.count,
  excluded_count: p.count,
  coverage: z.literal("only_supplied_sessions"),
});
const completenessOutput = z.strictObject({
  value: z.enum(["unknown", "partial", "complete", "not_tracked"]),
  source_id: z.uuid().nullable(),
  reported_at: p.instant.optional(),
});
const dailyOutput = z.strictObject({
  ...metadata,
  date: p.date,
  timezone: p.text(100),
  nutrition: nutritionSummaryOutput.optional(),
  hydration: hydrationSummaryOutput.optional(),
  activity: activitySummaryOutput.optional(),
  sleep: sleepSummaryOutput.optional(),
  checkin: z
    .strictObject({
      observations: z.array(storedRecord).max(1000),
      rating_aggregation: z.literal("individual_supplied_observations"),
    })
    .optional(),
  intake: z
    .strictObject({
      events: z.array(storedRecord).max(1000),
      supplement_nutrients: nutritionSummaryOutput,
      combined_dietary_supplement_total: z.null(),
    })
    .optional(),
  measurement: z.array(storedRecord).max(1000).optional(),
  lab_result: z.array(storedRecord).max(1000).optional(),
  diary_completeness: z.record(z.enum(recordTypes), completenessOutput),
  overlapping_studies: z
    .array(
      z.strictObject({
        source_id: z.uuid(),
        record_type: z.enum(recordTypes),
        period: p.effectivePeriod,
        labelled_as: z.enum([
          "overlapping_interval_study",
          "overlapping_interval_intake",
        ]),
      }),
    )
    .max(1000),
  quality_exclusions: z.strictObject({
    records: p.count,
    preliminary: p.count,
    cancelled: p.count,
    suspect_invalid: p.count,
  }),
  warnings: z.array(p.text(200)),
  source_ids: z.array(z.uuid()).max(1000),
});
const contextOutput = z.strictObject({
  ...metadata,
  server_time: p.instant,
  default_timezone: p.text(100),
  query_window: z.strictObject({ start_date: p.date, end_date: p.date }),
  latest_measurements: z
    .array(
      z.strictObject({
        source_id: z.uuid(),
        metric_key: p.text(100),
        observed_on: p.date.nullable(),
        age_days: p.count.nullable(),
        predates_query_window: z.boolean(),
        value: p.decimal.or(p.resultValue).or(
          z.strictObject({
            kind: z.literal("blood_pressure"),
            systolic: p.decimal.or(p.quantity),
            diastolic: p.decimal.or(p.quantity),
            pulse: p.decimal.or(p.quantity).optional(),
            unit: z.enum(["mmHg", "kPa"]),
          }),
        ),
        unit: p.text(80).optional(),
        provenance: p.provenance,
        series_context: z.record(p.text(100), z.json()),
      }),
    )
    .max(200),
  recent_days: z.array(dailyOutput).max(90),
  recent_labs: z.array(storedRecord).max(100).optional(),
  omitted_lab_count: p.count,
  undated_lab_count: p.count,
  warnings: z.array(p.text(200)),
  truncation: z.strictObject({
    has_more: z.boolean(),
    records_path: p.text(500),
  }),
});
const trendObservation = z.union([
  z.strictObject({
    date: p.date,
    value: computedSigned.nullable(),
    exact_decimal: p.text(10000).nullable(),
    basis: p.text(100),
    effective_result: summaryResult.nullable(),
    source_ids: sourceIds,
    definition_basis: definitionBasis.nullable(),
    coverage: p.text(500),
    estimated_count: p.count,
    qualified_count: p.count,
    missing_count: p.count,
    excluded_count: p.count,
    provenance: z
      .array(
        z.strictObject({
          source_id: z.uuid(),
          provenance: p.provenance,
          validity: p.validity,
        }),
      )
      .max(1000),
    known_subtotals: z.array(intakeSubtotal).max(1000),
    qualified_results: z.array(qualifiedSource).max(1000),
    warnings: z.array(p.text(200)),
  }),
  z.strictObject({
    source_id: z.uuid(),
    component_path: p.pointer.nullable(),
    date: p.date,
    occurred_at: p.instant.nullable(),
    value: computedSigned.nullable(),
    exact_decimal: p.text(10000).nullable(),
    supplied_result: p.decimal.or(p.resultValue).or(recordSchemas.measurement),
    source_status: p.sourceStatus,
    validity: p.validity,
    excluded_from_numeric: z.boolean(),
    period: p.effectivePeriod.nullable(),
    provenance: p.provenance,
    component_provenance: p.fieldOverride.optional(),
    component_validity: p.validity.optional(),
  }),
]);
const trendPoint = z.union([
  z.strictObject({
    date: p.date,
    value: computedSigned.nullable(),
    exact_decimal: p.text(10000).nullable(),
    contributing_records: p.count,
    source_ids: sourceIds,
    seven_day_moving_average: computedSigned.nullable().optional(),
    contributing_days: p.count.optional(),
  }),
  z.strictObject({
    start_date: p.date,
    end_date: p.date,
    value: computedSigned.nullable(),
    contributing_days: p.count,
    source_ids: sourceIds,
  }),
]);
const trendSeries = z.strictObject({
  identity: z.record(p.text(100), z.json()),
  observations: z.array(trendObservation).max(1000),
  aggregation: z.enum([
    "individual_irregular_observations",
    "mean_of_daily_values_week_bins_start_at_requested_start",
    "last_usable_per_local_day",
  ]),
  points: z.array(trendPoint).max(366),
});
const trendsOutput = z.strictObject({
  ...metadata,
  start_date: p.date,
  end_date: p.date,
  granularity: z.enum(["day", "week"]),
  metrics: z
    .array(
      z.strictObject({
        metric: p.text(200),
        series: z.array(trendSeries).max(1000),
        missing_dates: z.array(p.date).max(366),
        exclusions: p.count,
        warnings: z.array(p.text(200)),
      }),
    )
    .max(20),
});
export type Operation = {
  name: string;
  method: "GET" | "POST";
  path: string;
  input: z.ZodObject;
  output: z.ZodType;
  description: string;
  mutation: boolean;
  record_type?: RecordType;
  batch?: boolean;
};
export const operations: Operation[] = [
  {
    name: "health_get_context",
    method: "GET",
    path: "/v1/context",
    input: z.strictObject({
      lookback_days: z.number().int().min(1).max(90).optional(),
      include_labs: z.boolean().optional(),
      sections,
    }),
    output: contextOutput,
    mutation: false,
    description:
      "Read a bounded current snapshot with observation ages, provenance and missingness; no targets or coaching memory.",
  },
  {
    name: "health_get_daily_summary",
    method: "GET",
    path: "/v1/days/{date}",
    input: z.strictObject({ date: p.date, sections }),
    output: dailyOutput,
    mutation: false,
    description:
      "Read a local day with qualified daily-total precedence, known subtotals and completeness. Studies remain overlapping interval observations.",
  },
  {
    name: "health_get_trends",
    method: "GET",
    path: "/v1/trends",
    input: trendInput,
    output: trendsOutput,
    mutation: false,
    description:
      "Read up to 20 catalog metrics over at most 366 days, partitioned by supplied context. Use health_get_catalog for identifiers. No predictions.",
  },
  {
    name: "health_list_records",
    method: "GET",
    path: "/v1/records",
    input: listInput,
    output: pageOutput,
    mutation: false,
    description:
      "Page through recorded observations using allowlisted dates, types and source filters; no arbitrary predicates.",
  },
  {
    name: "health_get_record",
    method: "GET",
    path: "/v1/records/{id}",
    input: z.strictObject({
      id: z.uuid(),
      include_history: z.boolean().optional(),
      history_limit: z.number().int().min(1).max(100).optional(),
      history_before_version: p.count.optional(),
    }),
    output: recordOutput,
    mutation: false,
    description:
      "Retrieve one recorded observation and optionally a bounded page of immutable revisions.",
  },
  {
    name: "health_get_catalog",
    method: "GET",
    path: "/v1/catalog",
    input: catalogInput,
    output: catalogOutputSchema,
    mutation: false,
    description:
      "Discover exact supported keys, panel memberships, nested fields, units and complete schemas. Returns code definitions independently of health data.",
  },
];
const routes: Record<RecordType, string> = {
  measurement: "measurements",
  nutrition: "nutrition",
  hydration: "hydration",
  activity: "activities",
  sleep: "sleep",
  checkin: "checkins",
  intake: "intakes",
  lab_result: "lab-results",
};
const sharedLabMetadata = z.strictObject({
  ...commonEnvelope,
  provenance: p.provenance.optional(),
  laboratory: p.text(200).optional(),
  report_reference: p.text(200).optional(),
  report_revision: p.text(100).optional(),
  specimen: p.specimen.optional(),
  specimen_reference: p.text(200).optional(),
  collected_on: p.date.optional(),
  collected_at: p.instant.optional(),
  reported_on: p.date.optional(),
  reported_at: p.instant.optional(),
  method: p.methodContext.optional(),
  source_status: p.sourceStatus.optional(),
  original_panel_label: p.text(200).optional(),
});
for (const type of recordTypes) {
  const batch = type === "measurement" || type === "lab_result";
  const input =
    type === "measurement"
      ? z.strictObject({
          idempotency_key: idempotencyKey,
          records: z.array(recordInputs.measurement).min(1).max(100),
        })
      : type === "lab_result"
        ? z.strictObject({
            idempotency_key: idempotencyKey,
            records: z
              .array(
                z.strictObject({
                  ...commonEnvelope,
                  provenance: p.provenance.optional(),
                  data: labResultInput,
                }),
              )
              .min(1)
              .max(100),
            shared_metadata: sharedLabMetadata.optional(),
          })
        : z.strictObject({
            idempotency_key: idempotencyKey,
            ...recordInputs[type].shape,
          });
  operations.push({
    name:
      type === "measurement"
        ? "health_log_measurements"
        : type === "lab_result"
          ? "health_log_lab_results"
          : `health_log_${type}`,
    method: "POST",
    path: `/v1/${routes[type]}`,
    input,
    output: batch ? batchOutput : singleOutput,
    mutation: true,
    record_type: type,
    batch,
    description: `Save ${batch ? "an atomic bounded batch of" : "one"} supplied ${type} observation${batch ? "s" : ""}. Actual recorded events only. Use health_get_catalog for exact fields and units; do not infer missing values.`,
  });
}
const replacement = z.union(
  recordTypes.map((type) =>
    z.strictObject({
      record_type: z.literal(type),
      ...recordInputs[type].shape,
    }),
  ),
);
operations.push({
  name: "health_correct_record",
  method: "POST",
  path: "/v1/records/{id}/corrections",
  mutation: true,
  input: z.strictObject({
    id: z.uuid(),
    idempotency_key: idempotencyKey,
    expected_version: z.number().int().positive(),
    reason: p.text(300),
    replacement,
  }),
  output: singleOutput,
  description:
    "Correct one record using a complete replacement and expected version. Preserve history and supplied provenance; a voided record stays voided.",
});
operations.push({
  name: "health_void_record",
  method: "POST",
  path: "/v1/records/{id}/voids",
  mutation: true,
  input: z.strictObject({
    id: z.uuid(),
    idempotency_key: idempotencyKey,
    expected_version: z.number().int().positive(),
    reason: p.text(300),
  }),
  output: singleOutput,
  description:
    "Void one record using its expected version and a reason. Exclude it from effective calculations and preserve history; this is not permanent erasure.",
});
export const operationByName = new Map(
  operations.map((operation) => [operation.name, operation]),
);
export const restBody = (operation: Operation) => {
  const { id: _id, idempotency_key: _key, ...fields } = operation.input.shape;
  return z.strictObject(fields);
};
