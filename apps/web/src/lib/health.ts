export type Data = Record<string, unknown>;
export type HealthRecord = {
  id: string;
  record_type: string;
  occurred_on: string | null;
  occurred_at: string | null;
  ended_at: string | null;
  recorded_at: string;
  timezone: string;
  time_precision: string;
  date_basis: string;
  status: string;
  validity: string;
  provenance: { field_overrides?: Record<string, { validity?: string }> };
  data: Data;
};
export type GoalProgress = {
  goal: {
    metric: string;
    target: number;
    baseline: number | null;
    unit: string;
    direction: string;
  };
  actual: number | string | null;
  progress_percent: number | null;
  over_by: number | string | null;
  status: string;
  observed_on: string | null;
};
export type Log = {
  id: string;
  vital: string;
  type: string;
  time: string | null;
  metric: string;
  details: { label: string; value: string }[];
};
export const object = (value: unknown): Data =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : {};
export function number(value: unknown): number | null {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    value === "" ||
    !Number.isFinite(Number(value))
  )
    return null;
  return Number(value);
}
export const formatNumber = (value: unknown, digits = 1) => {
  const n = number(value);
  return n === null
    ? "—"
    : new Intl.NumberFormat("en", { maximumFractionDigits: digits }).format(n);
};
export function usable(record: HealthRecord, ...paths: string[]) {
  return (
    record.status === "active" &&
    record.validity === "valid" &&
    !["preliminary", "cancelled"].includes(String(record.data.source_status)) &&
    !Object.entries(record.provenance.field_overrides ?? {}).some(
      ([field, override]) =>
        override.validity &&
        override.validity !== "valid" &&
        paths.some((path) => field === path || path.startsWith(field + "/")),
    )
  );
}
export function exactWeight(record: HealthRecord) {
  const data = record.data;
  const value = object(data.value);
  const scalar = number(value.value ?? data.value);
  const unit = value.unit ?? data.unit;
  if (
    record.record_type !== "measurement" ||
    data.kind !== "scalar" ||
    data.metric_key !== "weight" ||
    !usable(
      record,
      "/value",
      "/unit",
      "/comparator",
      "/value/unit",
      "/value/value",
      "/value/comparator",
    ) ||
    (data.comparator !== undefined && data.comparator !== "eq") ||
    (value.comparator !== undefined && value.comparator !== "eq") ||
    (value.kind && value.kind !== "quantity") ||
    scalar === null ||
    scalar <= 0 ||
    !["kg", "lb"].includes(String(unit))
  )
    return null;
  return scalar * (unit === "lb" ? 0.45359237 : 1);
}
export function activityActual(
  summary: Data,
  records: HealthRecord[],
  minutes: boolean,
) {
  const activity = object(summary.activity);
  const field = minutes ? "exercise_seconds" : "active_energy_kcal";
  const total = number(
    object(object(activity.reported_daily_totals).values)[field],
  );
  if (total !== null) return total / (minutes ? 60 : 1);
  const workouts = records.filter(
    (record) =>
      record.record_type === "activity" &&
      record.data.entry_kind === "workout" &&
      usable(
        record,
        minutes ? "/exercise_seconds" : "/energy_kcal",
        ...(minutes ? [] : ["/energy_basis"]),
      ) &&
      typeof record.data[minutes ? "exercise_seconds" : "energy_kcal"] ===
        "number" &&
      (minutes || record.data.energy_basis === "active"),
  );
  if (
    workouts.some((a, index) =>
      workouts
        .slice(index + 1)
        .some(
          (b) =>
            a.occurred_at &&
            a.ended_at &&
            b.occurred_at &&
            b.ended_at &&
            a.occurred_at < b.ended_at &&
            b.occurred_at < a.ended_at,
        ),
    )
  )
    return null;
  const subtotals = object(activity.workout_subtotals);
  const source = object(
    minutes ? subtotals.exercise_seconds : object(subtotals.energy_kcal).active,
  );
  const value = number(source.exact_decimal ?? source.exact_value);
  return value === null ? null : value / (minutes ? 60 : 1);
}
export const moodLabels: Record<string, string> = {
  very_low: "Very low",
  low: "Low",
  neutral: "Neutral",
  good: "Good",
  great: "Great",
};
const label = (key: string) =>
  key.replace(/_/g, " ").replace(/\b\w/g, (s) => s.toUpperCase());
const unitFor = (key: string) =>
  key.endsWith("_kcal")
    ? "kcal"
    : key.endsWith("_ml")
      ? "mL"
      : key.endsWith("_g")
        ? "g"
        : key.endsWith("_m")
          ? "m"
          : "";
const comparators: Record<string, string> = {
  lt: "<",
  le: "≤",
  gt: ">",
  ge: "≥",
  eq: "",
};
export function resultText(
  value: unknown,
  unit?: unknown,
  comparator?: unknown,
): string {
  if (value === null || value === undefined) return "—";
  const result = object(value);
  if (result.kind === "absent" || result.kind === "unquantified") return "—";
  if (result.kind === "interval")
    return `${formatNumber(result.lower)}–${formatNumber(result.upper)} ${result.unit ?? unit ?? ""}`.trim();
  if (result.value !== undefined)
    return resultText(
      result.value,
      result.unit ?? unit,
      result.comparator ?? comparator,
    );
  if (result.kind)
    return String(result.display ?? result.text ?? result.dilution_text ?? "—");
  const n = number(value);
  if (n !== null)
    return `${comparators[String(comparator)] ?? ""}${formatNumber(n)} ${unit ?? ""}`.trim();
  return typeof value === "string" ? value : "—";
}
function nutrientValue(record: HealthRecord, key: string) {
  if (!usable(record, `/nutrients/${key}`, `/nutrient_qualifiers/${key}`))
    return "—";
  const qualifier = object(object(record.data.nutrient_qualifiers)[key]);
  if (["interval", "unquantified"].includes(String(qualifier.kind)))
    return resultText(qualifier, unitFor(key));
  return resultText(
    object(record.data.nutrients)[key],
    unitFor(key),
    qualifier.comparator,
  );
}
export function logView(record: HealthRecord, timezone: string): Log {
  const data = record.data;
  const details: Log["details"] = [];
  const add = (name: string, value: unknown) => {
    if (value !== undefined && value !== null && value !== "")
      details.push({ label: name, value: String(value) });
  };
  let vital = label(record.record_type);
  let metric = "—";
  const usableRecord = usable(record);
  switch (record.record_type) {
    case "nutrition":
      vital = "Nutrition";
      metric = nutrientValue(record, "energy_kcal");
      if (
        metric === "—" &&
        object(data.nutrients).energy_kj !== undefined &&
        usable(record, "/nutrients/energy_kj", "/nutrient_qualifiers/energy_kj")
      ) {
        const qualifier = object(object(data.nutrient_qualifiers).energy_kj);
        if (!qualifier.kind || qualifier.kind === "exact") {
          const kj = number(object(data.nutrients).energy_kj);
          if (kj !== null) metric = resultText(kj / 4.184, "kcal");
        }
      }
      add(
        data.entry_kind === "daily_total" ? "Daily total" : "Entry",
        data.label,
      );
      for (const [key, name] of [
        ["protein_g", "Protein"],
        ["carbohydrate_g", "Carbs"],
        ["fat_g", "Fat"],
        ["fiber_g", "Fiber"],
      ] as const)
        if (
          object(data.nutrients)[key] !== undefined ||
          object(data.nutrient_qualifiers)[key]
        )
          add(name, nutrientValue(record, key));
      break;
    case "hydration":
      vital =
        data.drink_type === "water" || data.drink_type === "sparkling_water"
          ? "Water"
          : "Hydration";
      metric =
        data.entry_kind === "daily_total"
          ? usable(record, "/water_ml")
            ? resultText(data.water_ml ?? data.total_fluids_ml, "mL")
            : "—"
          : usable(record, "/volume_ml")
            ? resultText(data.volume_ml, "mL")
            : "—";
      add(
        "Drink",
        typeof data.drink_type === "string" && label(data.drink_type) !== vital
          ? label(data.drink_type)
          : undefined,
      );
      add(
        "Entry",
        data.entry_kind === "daily_total" ? "Daily total" : data.label,
      );
      break;
    case "measurement":
      vital = label(
        String(data.metric_key ?? data.study_type ?? "Measurement"),
      );
      metric = usable(
        record,
        "/value",
        "/unit",
        "/comparator",
        "/value/value",
        "/value/unit",
        "/value/comparator",
      )
        ? resultText(data.value, data.unit, data.comparator)
        : "—";
      if (data.kind === "blood_pressure") {
        vital = "Blood pressure";
        metric = usable(record, "/systolic", "/diastolic", "/unit")
          ? `${resultText(data.systolic)}/${resultText(data.diastolic)} ${data.unit ?? ""}`
          : "—";
      }
      add("Site", data.measurement_site);
      add("Context", data.resting_state);
      add(
        "Pulse",
        data.pulse === undefined ? undefined : resultText(data.pulse, "bpm"),
      );
      break;
    case "activity": {
      vital = "Exercise";
      const daily = object(data.daily_totals);
      const kcal =
        data.entry_kind === "daily_total"
          ? daily.active_energy_kcal
          : data.energy_basis === "active"
            ? data.energy_kcal
            : undefined;
      metric = usable(
        record,
        data.entry_kind === "daily_total"
          ? "/daily_totals/active_energy_kcal"
          : "/energy_kcal",
        "/energy_basis",
      )
        ? resultText(kcal, "kcal")
        : "—";
      add(
        "Activity",
        data.activity_type ? label(String(data.activity_type)) : "Daily total",
      );
      const seconds =
        data.entry_kind === "daily_total"
          ? daily.exercise_seconds
          : data.exercise_seconds;
      if (
        usable(
          record,
          data.entry_kind === "daily_total"
            ? "/daily_totals/exercise_seconds"
            : "/exercise_seconds",
        ) &&
        number(seconds) !== null
      )
        add("Active minutes", resultText(number(seconds)! / 60, "min"));
      if (data.energy_basis === "gross")
        add("Gross energy", resultText(data.energy_kcal, "kcal"));
      if (data.elapsed_seconds !== undefined)
        add("Duration", resultText(Number(data.elapsed_seconds) / 60, "min"));
      add(
        "Distance",
        data.distance_m === undefined
          ? undefined
          : resultText(data.distance_m, "m"),
      );
      break;
    }
    case "checkin":
      vital = data.mood ? "Mood" : "Check-in";
      metric = usable(record, "/mood")
        ? (moodLabels[String(data.mood)] ?? "—")
        : "—";
      for (const [key, value] of Object.entries(object(data.ratings))) {
        const rating = object(value);
        add(
          label(key),
          `${resultText(rating.value)}${rating.upper !== undefined ? ` / ${rating.upper}` : ""}`,
        );
      }
      break;
    case "sleep":
      vital = "Sleep";
      metric =
        usable(record, "/sleep_seconds") && number(data.sleep_seconds) !== null
          ? resultText(Number(data.sleep_seconds) / 3600, "h")
          : "—";
      add(
        "Session",
        data.session_type ? label(String(data.session_type)) : undefined,
      );
      break;
    case "intake":
      vital = "Intake";
      metric = typeof data.status === "string" ? label(data.status) : "—";
      add("Item", data.label ?? object(data.item).name);
      add("Dose", data.dose ? resultText(data.dose) : undefined);
      break;
    case "lab_result":
      vital = label(String(data.analyte_key ?? "Lab result"));
      metric = usable(
        record,
        "/value",
        "/result",
        "/unit",
        "/value/value",
        "/result/value",
      )
        ? resultText(data.result ?? data.value, data.unit)
        : "—";
      add(
        "Specimen",
        object(data.specimen).type ??
          (typeof data.specimen === "string" ? data.specimen : undefined),
      );
      break;
  }
  if (!usableRecord) {
    metric = "—";
    add(
      "Status",
      label(
        record.validity !== "valid"
          ? record.validity
          : String(data.source_status ?? record.status),
      ),
    );
  }
  add("Notes", data.notes);
  return {
    id: record.id,
    vital,
    type: record.record_type,
    time: record.occurred_at
      ? new Intl.DateTimeFormat("en", {
          hour: "numeric",
          minute: "2-digit",
          timeZone: timezone,
        }).format(new Date(record.occurred_at))
      : null,
    metric,
    details,
  };
}
export function sortRecords(records: HealthRecord[]) {
  return [...records].sort(
    (a, b) =>
      (b.occurred_on ?? "").localeCompare(a.occurred_on ?? "") ||
      Date.parse(b.occurred_at ?? b.recorded_at) -
        Date.parse(a.occurred_at ?? a.recorded_at) ||
      Date.parse(b.recorded_at) - Date.parse(a.recorded_at) ||
      b.id.localeCompare(a.id),
  );
}
export function sortWeightRecords(records: HealthRecord[]) {
  return [...records].sort(
    (a, b) =>
      (b.occurred_on ?? "").localeCompare(a.occurred_on ?? "") ||
      (b.occurred_at ?? "").localeCompare(a.occurred_at ?? "") ||
      Date.parse(b.recorded_at) - Date.parse(a.recorded_at) ||
      b.id.localeCompare(a.id),
  );
}
export function dateOffset(date: string, days: number) {
  const value = new Date(date + "T12:00:00Z");
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
export function dateLabel(date: string, weekday = false) {
  return new Intl.DateTimeFormat("en", {
    ...(weekday ? { weekday: "long" as const } : {}),
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(date + "T12:00:00Z"));
}
