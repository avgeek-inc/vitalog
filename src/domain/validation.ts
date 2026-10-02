import { Decimal } from "decimal.js";
import {
  CATALOG_VERSION,
  labByKey,
  measurementByKey,
  RECORD_SCHEMA_VERSION,
  type RecordType,
  inventory,
} from "../registry/definitions.js";
import { recordInputs } from "../registry/records.js";
import { fail, parse } from "../errors.js";
import { at, object, type Data, type RecordInput } from "./types.js";

export const CLOCK_SKEW_MS = 300_000;
export const localDate = (instant: string | Date, timezone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
export function validTimezone(zone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone }).format();
  } catch {
    fail("/timezone", "Use a valid IANA timezone");
  }
}
const number = (value: unknown) => new Decimal(value as string | number);
function recursiveRules(
  value: unknown,
  path: string,
  now: Date,
  timezone: string,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      recursiveRules(item, `${path}/${index}`, now, timezone),
    );
    return;
  }
  if (value === null || typeof value !== "object") return;
  const v = object(value);
  if (Object.keys(v).length > 200) fail(path, "Object has too many members");
  if (
    v.lower !== undefined &&
    v.upper !== undefined &&
    number(v.lower).gt(number(v.upper))
  )
    fail(path, "Lower bound exceeds upper bound");
  if (
    (v.kind === "ratio" || v.kind === "titer") &&
    v.denominator !== undefined &&
    number(v.denominator).isZero()
  )
    fail(`${path}/denominator`, "Denominator cannot be zero");
  if (
    v.kind === "titer" &&
    (v.numerator === undefined) !== (v.denominator === undefined)
  )
    fail(path, "Supply both dilution numbers or neither");
  if (v.kind === "absent" && v.reason === "other" && !v.explanation)
    fail(path, "Explain the other absence reason");
  if (
    v.kind === "susceptibility_result" &&
    !v.mic &&
    !v.disk_zone &&
    !v.interpretation
  )
    fail(path, "Supply a source result");
  if (
    v.kind === "quantity" &&
    v.reported_precision !== undefined &&
    typeof v.value === "string" &&
    Number(v.reported_precision) < (v.value.split(".")[1]?.length ?? 0)
  )
    fail(path, "Printed decimal exceeds declared precision");
  for (const key of [
    "start",
    "end",
    "start_at",
    "end_at",
    "collected_at",
    "reported_at",
    "received_at",
    "analyzed_at",
    "reported_on",
    "collected_on",
    "period_start",
    "period_end",
    "reported_at",
    "onset",
    "last_dose_at",
    "date",
  ]) {
    const time = v[key];
    if (typeof time === "string" && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(time)) {
      if (
        time.includes("T") &&
        new Date(time).getTime() > now.getTime() + CLOCK_SKEW_MS
      )
        fail(
          `${path}/${key}`,
          "Completed observations cannot be in the future",
        );
      if (!time.includes("T") && time > localDate(now, timezone))
        fail(
          `${path}/${key}`,
          "Completed observations cannot have future dates",
        );
    }
  }
  for (const [start, end] of [
    ["start", "end"],
    ["start_at", "end_at"],
    ["period_start", "period_end"],
  ]) {
    if (
      typeof v[start!] === "string" &&
      typeof v[end!] === "string" &&
      String(v[start!]) > String(v[end!]) &&
      new Date(String(v[start!])).getTime() >
        new Date(String(v[end!])).getTime()
    )
      fail(path, "Start must not follow end");
  }
  if (v.scale && v.value !== undefined) {
    if (v.lower !== undefined && number(v.value).lt(number(v.lower)))
      fail(path, "Score is below its supplied scale");
    if (v.upper !== undefined && number(v.value).gt(number(v.upper)))
      fail(path, "Score exceeds its supplied scale");
    if (
      v.scale === "borg_6_20" &&
      (number(v.value).lt(6) || number(v.value).gt(20))
    )
      fail(path, "Borg 6–20 uses values from 6 to 20");
    if (v.scale === "cr10" && (number(v.value).lt(0) || number(v.value).gt(10)))
      fail(path, "CR10 uses values from 0 to 10");
  }
  if (v.time_precision) {
    const isInstant =
      (typeof v.start === "string" && v.start.includes("T")) ||
      (typeof v.end === "string" && v.end.includes("T"));
    if (v.time_precision === "date" && isInstant)
      fail(path, "Period precision conflicts with supplied instants");
    if (
      v.time_precision === "instant" &&
      ((typeof v.start === "string" && !v.start.includes("T")) ||
        (typeof v.end === "string" && !v.end.includes("T")))
    )
      fail(path, "Period precision conflicts with date-only endpoints");
    if (
      v.start === undefined &&
      v.end === undefined &&
      v.duration_seconds === undefined &&
      path.endsWith("period")
    )
      fail(path, "Supply known endpoints or duration");
    if (v.timezone) validTimezone(String(v.timezone));
  }
  if (
    v.expected_samples !== undefined &&
    v.observed_samples !== undefined &&
    Number(v.observed_samples) > Number(v.expected_samples)
  )
    fail(path, "Observed sample count exceeds expected samples");
  for (const [key, child] of Object.entries(v))
    recursiveRules(child, `${path}/${key}`, now, timezone);
}

export function validateNutrients(data: Data, field = "nutrients"): void {
  const values = object(data[field]);
  for (const [key, qualifier] of Object.entries(
    object(data.nutrient_qualifiers),
  )) {
    if (!(key in values))
      fail(
        `/data/nutrient_qualifiers/${key}`,
        "Qualifier requires the corresponding nutrient",
      );
    const q = object(qualifier);
    if (
      ["interval", "unquantified"].includes(String(q.kind)) &&
      values[key] !== null
    )
      fail(
        `/data/${field}/${key}`,
        "Intervals and unquantified values require a null scalar",
      );
    if (
      ["exact", "bound"].includes(String(q.kind)) &&
      typeof values[key] !== "number"
    )
      fail(`/data/${field}/${key}`, "Point/bound qualifier requires a scalar");
    if (
      q.kind === "interval" &&
      q.unit !==
        inventory.nutrient_entries.find((entry) => entry.key === key)?.unit
    )
      fail(
        `/data/nutrient_qualifiers/${key}/unit`,
        "Unit must match the nutrient key",
      );
  }
  for (const key of Object.keys(object(data.component_details)))
    if (!(key in values))
      fail(
        `/data/component_details/${key}`,
        "Definition metadata requires a corresponding supplied nutrient",
      );
}

function measurementRules(data: Data): void {
  if (data.kind === "scalar")
    validateScalar(String(data.metric_key), data, "/data");
  if (data.kind === "blood_pressure") {
    for (const key of ["systolic", "diastolic", "pulse"])
      if (data[key] !== undefined) {
        const v = object(data[key]);
        const amount = typeof data[key] === "object" ? v.value : data[key];
        if (number(amount).lt(0))
          fail(`/data/${key}`, "Pressure and pulse cannot be negative");
        if (v.unit && v.unit !== (key === "pulse" ? "bpm" : data.unit))
          fail(`/data/${key}/unit`, "Unit conflicts with the paired reading");
      }
  }
  if (data.kind === "study_summary") {
    const groups: Record<string, string[]> = {
      cgm_summary: ["blood_glucose", "interstitial_glucose"],
      ambulatory_bp_summary: [
        "heart_rate",
        "pulse_pressure",
        "mean_arterial_pressure",
      ],
      spirometry_summary: inventory.measurement_groups.respiratory_temperature,
      body_composition_summary:
        inventory.measurement_groups.anthropometry_body_composition,
      dxa_summary: [
        ...inventory.measurement_groups.bone,
        ...inventory.measurement_groups.anthropometry_body_composition,
      ],
      ecg_summary: inventory.measurement_groups.cardiovascular,
      echocardiography_summary: inventory.measurement_groups.cardiovascular,
      functional_test_summary: inventory.measurement_groups.fitness_function,
    };
    for (const [key, value] of Object.entries(object(data.components))) {
      if (!groups[String(data.study_type)]?.includes(key))
        fail(
          `/data/components/${key}`,
          "Component does not belong to this study type",
        );
      validateScalar(
        key,
        { ...object(value), ...object(object(value).context) },
        `/data/components/${key}`,
      );
    }
    if (
      (data.cgm && data.study_type !== "cgm_summary") ||
      (data.ambulatory_bp && data.study_type !== "ambulatory_bp_summary")
    )
      fail(
        "/data/study_type",
        "Study-specific section conflicts with the study type",
      );
  }
}
function validateScalar(key: string, data: Data, path: string): void {
  const definition = measurementByKey.get(key)!;
  const value = data.value;
  const v = object(value);
  const kind = typeof value === "object" ? String(v.kind) : "quantity";
  if (!definition.result_variants.includes(kind))
    fail(`${path}/value`, "This result shape is not supported for the metric");
  if (kind === "absent") return;
  const unit = v.unit ?? data.unit;
  if (kind === "quantity" || kind === "interval") {
    if (!unit || !definition.recognized_units.includes(String(unit)))
      fail(`${path}/unit`, "Use a catalogued unit for this measurement");
    for (const amount of [
      v.value ?? (typeof value !== "object" ? value : undefined),
      v.lower,
      v.upper,
    ]) {
      if (
        amount !== undefined &&
        !definition.allow_negative &&
        number(amount).lt(0)
      )
        fail(`${path}/value`, "This quantity cannot be negative");
      if (
        amount !== undefined &&
        unit === "%" &&
        key !== "global_longitudinal_strain" &&
        number(amount).gt(100)
      )
        fail(`${path}/value`, "A percentage fraction cannot exceed 100");
    }
  }
  if (v.unit && data.unit && v.unit !== data.unit)
    fail(`${path}/unit`, "Outer and result units must agree");
  const metadata = object(data.classification_metadata);
  for (const field of definition.required_context)
    if (data[field] === undefined && metadata[field] === undefined)
      fail(`${path}/${field}`, "Required context for this metric is missing");
}

export function normalizeInput(
  type: RecordType,
  raw: unknown,
  defaultTimezone: string,
  now = new Date(),
): Required<Omit<RecordInput, "validity">> & {
  validity: "valid" | "suspect" | "invalid";
  warnings: string[];
  time_context: {
    original_occurred_at: string | null;
    original_ended_at: string | null;
    supplied_timezone: string | null;
  };
} {
  const input = parse<unknown>(recordInputs[type], raw) as RecordInput;
  const timezone = input.timezone ?? defaultTimezone;
  validTimezone(timezone);
  const data = input.data;
  const suppliedStart =
    type === "lab_result" ? data.collected_at : data.start_at;
  if (
    input.occurred_at &&
    typeof suppliedStart === "string" &&
    new Date(input.occurred_at).getTime() !== new Date(suppliedStart).getTime()
  )
    fail(
      "/occurred_at",
      "Common timestamp conflicts with the supplied observation timestamp",
    );
  if (
    input.ended_at &&
    typeof data.end_at === "string" &&
    new Date(input.ended_at).getTime() !== new Date(data.end_at).getTime()
  )
    fail("/ended_at", "Common end timestamp conflicts with the supplied end");
  recursiveRules(data, "/data", now, timezone);
  let occurredAt = input.occurred_at ?? null;
  let endedAt = input.ended_at ?? null;
  let occurredOn = input.occurred_on ?? null;
  let basis = input.date_basis ?? "reported_date";
  let precision = input.time_precision ?? (occurredAt ? "instant" : "date");
  if (type === "lab_result") {
    const result = object(data.result);
    if (
      data.analyte_kind === "builtin" &&
      !labByKey
        .get(String(data.analyte_key))!
        .result_variants.includes(String(result.kind))
    )
      fail(
        "/data/result/kind",
        "Result shape is not permitted by the analyte definition",
      );
    if (data.unit && result.unit && data.unit !== result.unit)
      fail("/data/unit", "Outer and result units conflict");
    if (result.kind === "quantity" && !result.unit && !data.unit)
      fail(
        "/data/result/unit",
        "Quantities require a supplied unit, including 1 for dimensionless values",
      );
    occurredAt =
      typeof data.collected_at === "string" ? data.collected_at : null;
    const collectionStart = object(data.collection_period).start;
    occurredOn =
      typeof data.collected_on === "string"
        ? data.collected_on
        : occurredAt
          ? localDate(occurredAt, timezone)
          : typeof collectionStart === "string"
            ? collectionStart.includes("T")
              ? localDate(collectionStart, timezone)
              : collectionStart
            : null;
    basis = occurredOn ? "specimen_date" : "unknown";
    if (!occurredOn) {
      occurredAt =
        typeof data.reported_at === "string" ? data.reported_at : null;
      occurredOn =
        typeof data.reported_on === "string"
          ? data.reported_on
          : occurredAt
            ? localDate(occurredAt, timezone)
            : null;
      if (occurredOn) basis = "report_date";
    }
    if (!occurredOn && input.occurred_on) {
      occurredOn = input.occurred_on;
      occurredAt = input.occurred_at ?? null;
      basis =
        input.date_basis === "specimen_date" ? "specimen_date" : "report_date";
    }
    precision = data.collection_period
      ? "period"
      : occurredAt
        ? "instant"
        : occurredOn
          ? "date"
          : "unknown";
    if (input.occurred_on && occurredOn && input.occurred_on !== occurredOn)
      fail(
        "/occurred_on",
        "Common date conflicts with the effective specimen/report date",
      );
    if (
      occurredOn &&
      occurredAt &&
      localDate(occurredAt, timezone) !== occurredOn
    )
      fail(
        "/data/collected_on",
        "Laboratory date conflicts with its local timestamp",
      );
    if (data.collection_period && object(data.collection_period).end)
      endedAt = String(object(data.collection_period).end).includes("T")
        ? String(object(data.collection_period).end)
        : null;
    for (const panel of (data.panel_keys as string[] | undefined) ?? [])
      if (
        data.analyte_kind === "builtin" &&
        !labByKey.get(String(data.analyte_key))!.panel_keys.includes(panel)
      )
        fail("/data/panel_keys", "Analyte is outside the supplied panel");
  } else {
    if (type === "sleep") {
      if ((data.start_at && !data.end_at) || (data.end_at && !data.start_at))
        fail("/data", "Supply both sleep session endpoints or neither");
      occurredAt =
        typeof data.start_at === "string" ? data.start_at : occurredAt;
      endedAt = typeof data.end_at === "string" ? data.end_at : endedAt;
      if (
        data.entry_kind === "study_summary" &&
        !object(data.study_metadata).effective_period
      )
        fail(
          "/data/study_metadata/effective_period",
          "Sleep studies require a supplied effective period",
        );
      if (endedAt) {
        const wake = localDate(endedAt, timezone);
        if (occurredOn && wake !== occurredOn)
          fail("/occurred_on", "Sleep must use its local wake date");
        occurredOn = wake;
        basis = "wake_date";
        precision = "instant";
      } else basis = "wake_date";
      if (
        !data.sleep_seconds &&
        !data.time_in_bed_seconds &&
        !data.start_at &&
        !data.study_metadata &&
        data.sleep_seconds !== 0
      )
        fail("/data", "Supply an actual session duration or study");
      if (data.stage_durations && !data.stage_system)
        fail("/data/stage_system", "Name the reported stage system");
      if (
        data.sleep_seconds !== undefined &&
        data.time_in_bed_seconds !== undefined &&
        Number(data.sleep_seconds) > Number(data.time_in_bed_seconds)
      )
        fail("/data/sleep_seconds", "Sleep duration exceeds time in bed");
    } else {
      if (["activity", "intake"].includes(type)) {
        occurredAt =
          typeof data.start_at === "string" ? data.start_at : occurredAt;
        endedAt = typeof data.end_at === "string" ? data.end_at : endedAt;
      }
      if (occurredAt) {
        const day = localDate(occurredAt, timezone);
        if (occurredOn && day !== occurredOn)
          fail("/occurred_on", "Date conflicts with the local timestamp");
        basis = "event_date";
        precision = "instant";
      }
    }
    if (!occurredOn) fail("/occurred_on", "Supply an explicit calendar date");
    if (data.entry_kind === "daily_total" && (occurredAt || endedAt))
      fail("/occurred_at", "Daily totals do not have event instants");
  }
  if (input.time_precision === "date" && (occurredAt || endedAt))
    fail(
      "/time_precision",
      "Date-only precision conflicts with supplied timestamps",
    );
  if (input.time_precision === "instant" && !occurredAt)
    fail("/time_precision", "Instant precision requires a timestamp");
  if (
    (occurredAt &&
      new Date(occurredAt).getTime() > now.getTime() + CLOCK_SKEW_MS) ||
    (endedAt && new Date(endedAt).getTime() > now.getTime() + CLOCK_SKEW_MS)
  )
    fail("/occurred_at", "Completed events cannot be in the future");
  if (occurredAt && endedAt && new Date(endedAt) < new Date(occurredAt))
    fail("/ended_at", "End must not precede start");
  if (occurredOn && occurredOn > localDate(now, timezone))
    fail("/occurred_on", "Completed events cannot have future dates");
  if (type === "nutrition") validateNutrients(data);
  if (type === "intake") {
    validateNutrients(data, "nutrient_contributions");
    if (
      data.status === "partially_taken" &&
      !data.administered_quantity &&
      !data.notes
    )
      fail(
        "/data/administered_quantity",
        "Partial intake needs an amount or explanation",
      );
    if (
      ["missed", "skipped"].includes(String(data.status)) &&
      ((data.administered_quantity &&
        !number(object(data.administered_quantity).value).isZero()) ||
        (data.nutrient_contributions &&
          Object.values(object(data.nutrient_contributions)).some(
            (v) => typeof v === "number" && v > 0,
          )))
    )
      fail(
        "/data",
        "Missed/skipped events cannot contribute an administered amount",
      );
    for (const [index, ingredient] of (
      (data.ingredients as Data[] | undefined) ?? []
    ).entries()) {
      const denominator = object(object(ingredient.strength).denominator).value;
      if (denominator !== undefined && number(denominator).lte(0))
        fail(
          `/data/ingredients/${index}/strength/denominator`,
          "Strength denominator must be positive",
        );
    }
  }
  if (type === "hydration" && data.entry_kind === "daily_total") {
    if (data.water_ml === undefined && data.total_fluids_ml === undefined)
      fail("/data", "Supply at least one daily fluid field");
    if (
      typeof data.water_ml === "number" &&
      typeof data.total_fluids_ml === "number" &&
      data.water_ml > data.total_fluids_ml
    )
      fail("/data/water_ml", "Plain water is included in total fluids");
  }
  if (type === "measurement") measurementRules(data);
  if (type === "activity") {
    if (data.activity_type === "other" && !data.activity_label)
      fail("/data/activity_label", "Name the completed activity");
    if (data.cadence !== undefined && !data.cadence_unit)
      fail("/data/cadence_unit", "Cadence needs an explicit denominator");
    if (data.energy_kcal !== undefined && !data.energy_basis)
      fail("/data/energy_basis", "Specify active, gross or unknown energy");
    if (
      data.elapsed_seconds !== undefined &&
      (Number(data.moving_seconds ?? 0) > Number(data.elapsed_seconds) ||
        Number(data.paused_seconds ?? 0) > Number(data.elapsed_seconds) ||
        (data.moving_seconds !== undefined &&
          data.paused_seconds !== undefined &&
          Number(data.moving_seconds) + Number(data.paused_seconds) >
            Number(data.elapsed_seconds)))
    )
      fail("/data", "Moving/pause duration exceeds elapsed duration");
  }
  const overrides = input.provenance.field_overrides ?? {};
  if (Object.keys(overrides).length > 50)
    fail("/provenance/field_overrides", "At most 50 field overrides");
  for (const path of Object.keys(overrides))
    if (at(data, path) === undefined)
      fail(
        `/provenance/field_overrides/${path}`,
        "Override must refer to an existing indexed payload field",
      );
  const warnings: string[] = [];
  if (
    type === "measurement" &&
    data.metric_key === "heart_rate" &&
    typeof data.value === "number" &&
    (data.value < 20 || data.value > 250)
  )
    warnings.push("unusual_supplied_value");
  if (!occurredOn) warnings.push("undated_result");
  if (
    data.source_status === "preliminary" ||
    data.source_status === "cancelled"
  )
    warnings.push("source_status_excluded_by_default");
  return {
    occurred_on: occurredOn,
    occurred_at: occurredAt ? new Date(occurredAt).toISOString() : null,
    ended_at: endedAt ? new Date(endedAt).toISOString() : null,
    timezone,
    time_precision: precision,
    date_basis: basis,
    provenance: input.provenance,
    validity: input.validity ?? "valid",
    data,
    warnings,
    time_context: {
      original_occurred_at: occurredAt,
      original_ended_at: endedAt,
      supplied_timezone: input.timezone ?? null,
    },
  };
}

export const validationRules = [
  "strict_known_fields",
  "real_calendar_dates",
  "iana_timezone",
  "local_date_consistency",
  "sleep_wake_date",
  "completed_events_only_5_minute_clock_skew",
  "laboratory_specimen_then_report_date",
  "no_fabricated_instants",
  "ordered_intervals",
  "nonzero_denominators",
  "catalogued_measurement_units",
  "allowed_analyte_result_shapes",
  "nutrient_qualifier_consistency",
  "field_overrides_existing_indexed_paths",
  "daily_total_uniqueness",
  "referential_integrity_and_hierarchy_cycles",
  "optimistic_version_check",
  "durable_cross_transport_idempotency",
];
export function readStoredSnapshot(
  snapshot: unknown,
  schemaVersion: number,
): Data {
  if (![1, RECORD_SCHEMA_VERSION].includes(schemaVersion))
    throw new Error("Unsupported stored record schema version");
  return object(snapshot);
}
export function upgradeSnapshot(snapshot: unknown, schemaVersion: number) {
  return {
    schema_version: RECORD_SCHEMA_VERSION,
    snapshot: structuredClone(readStoredSnapshot(snapshot, schemaVersion)),
    catalog_version: CATALOG_VERSION,
  };
}
