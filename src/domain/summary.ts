import { Decimal } from "decimal.js";
import {
  CATALOG_VERSION,
  nonAdditiveGroups,
  nutrientKeys,
  moodValues,
  recordTypes,
} from "../registry/definitions.js";
import { localDate } from "./validation.js";
import {
  object,
  usable,
  valueKindAt,
  type Data,
  type HealthRecord,
} from "./types.js";

Decimal.set({ precision: 1000 });
const sum = (values: (string | number)[]) =>
  values.reduce(
    (total, value) => total.plus(new Decimal(value)),
    new Decimal(0),
  );
export function numericProjection(value: Decimal): string | number {
  const number = value.toNumber();
  return Number.isFinite(number) && (number !== 0 || value.isZero())
    ? number
    : value.toFixed();
}
const representation = (value: Decimal | null) => ({
  exact_value: value ? numericProjection(value) : null,
  exact_decimal: value ? value.toFixed() : null,
});
export function point(value: unknown, comparator?: unknown): Decimal | null {
  if (typeof value === "string" || typeof value === "number")
    return comparator && comparator !== "eq" ? null : new Decimal(value);
  const result = object(value);
  const effectiveComparator = result.comparator ?? comparator;
  return result.kind === "quantity" &&
    (!effectiveComparator || effectiveComparator === "eq")
    ? new Decimal(result.value as string | number)
    : null;
}
function ingredientBasis(record: HealthRecord, key: string): string {
  const detail = object(object(record.data.component_details)[key]);
  return JSON.stringify({
    expression_basis: detail.expression_basis ?? "unknown",
    form: detail.form ?? "unknown",
    method: detail.method ?? "unknown",
    definition: detail.definition ?? "unknown",
    definition_version: detail.definition_version ?? "unknown",
    source_definition_reference:
      detail.source_definition_reference ?? "unknown",
    carbohydrate_definition:
      key === "carbohydrate_g"
        ? (record.data.carbohydrate_definition ?? "unknown")
        : undefined,
    fiber_method: key.includes("fiber")
      ? (record.data.fiber_method ?? "unknown")
      : undefined,
    folate_basis:
      key === "folate_ug" ? (record.data.folate_basis ?? "unknown") : undefined,
    energy_method: key.startsWith("energy_")
      ? (record.data.energy_method ?? "reported_unspecified")
      : undefined,
  });
}
function nutrientResult(
  record: HealthRecord,
  key: string,
  supplement = false,
): Data | null {
  const value = object(
    record.data[supplement ? "nutrient_contributions" : "nutrients"],
  )[key];
  const qualifier = object(object(record.data.nutrient_qualifiers)[key]);
  if (qualifier.kind === "interval" || qualifier.kind === "unquantified")
    return { ...qualifier };
  if (value === undefined || value === null) return null;
  return { kind: qualifier.kind ?? "exact", value, ...qualifier };
}
function nutrientUsable(
  record: HealthRecord,
  key: string,
  supplement = false,
): boolean {
  const root = supplement ? "nutrient_contributions" : "nutrients";
  if (!usable(record, `/${root}/${key}`)) return false;
  const qualifier = object(object(record.data.nutrient_qualifiers)[key]);
  for (const field of [
    "kind",
    "comparator",
    "lower",
    "upper",
    "lower_inclusive",
    "upper_inclusive",
    "unit",
    "reason",
  ])
    if (
      qualifier[field] !== undefined &&
      !usable(record, `/nutrient_qualifiers/${key}/${field}`)
    )
      return false;
  const detail = object(object(record.data.component_details)[key]);
  for (const field of Object.keys(detail).filter(
    (field) => field !== "coverage",
  ))
    if (!usable(record, `/component_details/${key}/${field}`)) return false;
  return true;
}
function nutrient(
  records: HealthRecord[],
  key: string,
  supplement = false,
): Data {
  const field = supplement ? "nutrient_contributions" : "nutrients";
  const usableRecords = records.filter((record) =>
    nutrientUsable(record, key, supplement),
  );
  const intakes = usableRecords.filter(
    (record) => supplement || record.data.entry_kind === "intake",
  );
  const daily = usableRecords.find(
    (record) =>
      record.data.entry_kind === "daily_total" &&
      nutrientResult(record, key, supplement) !== null,
  );
  const groups = new Map<string, { values: Decimal[]; ids: string[] }>();
  let qualified = 0,
    missing = 0,
    estimated = 0;
  const qualifiedResults: Data[] = [];
  for (const record of intakes) {
    const result = nutrientResult(record, key, supplement);
    if (!result) {
      missing++;
      continue;
    }
    if (valueKindAt(record, `/${field}/${key}`) === "estimated") estimated++;
    if (result.kind !== "exact") {
      qualified++;
      qualifiedResults.push({
        source_id: record.id,
        result,
        provenance: record.provenance,
        definition_basis: JSON.parse(ingredientBasis(record, key)),
      });
      continue;
    }
    const basis = ingredientBasis(record, key);
    const group = groups.get(basis) ?? { values: [], ids: [] };
    group.values.push(new Decimal(result.value as number));
    group.ids.push(record.id);
    groups.set(basis, group);
  }
  const subtotals = [...groups].map(([basis, values]) => ({
    definition_basis: JSON.parse(basis),
    ...representation(sum(values.values.map((value) => value.toFixed()))),
    source_ids: values.ids,
  }));
  const dailyResult = daily ? nutrientResult(daily, key, supplement) : null;
  const exact =
    dailyResult?.kind === "exact"
      ? new Decimal(dailyResult.value as number)
      : !dailyResult && groups.size === 1
        ? new Decimal(subtotals[0]!.exact_decimal!)
        : null;
  const sourceIds = daily
    ? [daily.id]
    : intakes
        .filter((record) => nutrientResult(record, key, supplement) !== null)
        .map((record) => record.id);
  return {
    effective_result:
      dailyResult ??
      (exact
        ? {
            kind: "exact",
            value: numericProjection(exact),
            exact_decimal: exact.toFixed(),
          }
        : null),
    ...representation(exact),
    basis: daily
      ? "reported_daily_total"
      : groups.size > 1
        ? "incompatible_definition"
        : "known_intake_subtotal",
    definition_basis: daily
      ? JSON.parse(ingredientBasis(daily, key))
      : groups.size === 1
        ? subtotals[0]!.definition_basis
        : null,
    source_ids: sourceIds,
    known_intake_subtotals: subtotals,
    qualified_results: qualifiedResults,
    qualified_count:
      qualified + (dailyResult && dailyResult.kind !== "exact" ? 1 : 0),
    missing_count: missing,
    estimated_count:
      estimated +
      (daily && valueKindAt(daily, `/${field}/${key}`) === "estimated" ? 1 : 0),
    excluded_count: records.length - usableRecords.length,
    coverage: "only_supplied_fields",
    reported_coverage: daily
      ? (object(object(daily.data.component_details)[key]).coverage ?? null)
      : null,
    warnings: [
      ...(groups.size > 1 && !daily ? ["incompatible_definition"] : []),
      ...(qualified || missing ? ["incomplete_nutrient_coverage"] : []),
    ],
  };
}
const energyTolerance = new Decimal("0.02");
function energyResult(
  record: HealthRecord,
  supplement = false,
): { result: Data | null; conflicting: boolean; source_unit: string | null } {
  const kcal = nutrientUsable(record, "energy_kcal", supplement)
    ? nutrientResult(record, "energy_kcal", supplement)
    : null;
  const kj = nutrientUsable(record, "energy_kj", supplement)
    ? nutrientResult(record, "energy_kj", supplement)
    : null;
  if (!kcal && !kj)
    return { result: null, conflicting: false, source_unit: null };
  const convert = (result: Data): Data => {
    const out = { ...result };
    for (const key of ["value", "lower", "upper"])
      if (typeof out[key] === "number") {
        const converted = new Decimal(out[key]).div("4.184");
        out[key] = numericProjection(converted);
        out[`${key}_decimal`] = converted.toFixed();
      }
    out.unit = "kcal";
    return out;
  };
  const converted = kj ? convert(kj) : null;
  if (kcal && converted) {
    if (kcal.kind !== converted.kind)
      return { result: null, conflicting: true, source_unit: "kcal+kJ" };
    if (kcal.kind === "exact" || kcal.kind === "bound") {
      const a = new Decimal(kcal.value as number),
        b = new Decimal(converted.value_decimal as string);
      if (
        a
          .minus(b)
          .abs()
          .gt(Decimal.max(1, a.abs().mul(energyTolerance))) ||
        kcal.comparator !== converted.comparator
      )
        return { result: null, conflicting: true, source_unit: "kcal+kJ" };
    } else if (kcal.kind === "interval") {
      if (
        ["lower", "upper"].some((key) => {
          const boundary = new Decimal(kcal[key] as number);
          return boundary
            .minus(String(converted[`${key}_decimal`]))
            .abs()
            .gt(Decimal.max(1, boundary.abs().mul(energyTolerance)));
        }) ||
        ["lower_inclusive", "upper_inclusive"].some(
          (key) => kcal[key] !== converted[key],
        )
      )
        return { result: null, conflicting: true, source_unit: "kcal+kJ" };
    } else if (kcal.kind === "unquantified" && kcal.reason !== converted.reason)
      return { result: null, conflicting: true, source_unit: "kcal+kJ" };
  }
  return {
    result: kcal ?? converted,
    conflicting: false,
    source_unit: kcal ? "kcal" : "kJ",
  };
}
function energy(records: HealthRecord[], supplement = false): Data {
  const usableRecords = records.filter((record) =>
    usable(record, supplement ? "/nutrient_contributions" : "/nutrients"),
  );
  const intakes = usableRecords.filter(
    (record) => supplement || record.data.entry_kind === "intake",
  );
  const daily = usableRecords.find(
    (record) =>
      record.data.entry_kind === "daily_total" &&
      (energyResult(record, supplement).result ||
        energyResult(record, supplement).conflicting),
  );
  const intakeResults = intakes.map((record) => ({
    record,
    ...energyResult(record, supplement),
  }));
  const dailyResult = daily ? energyResult(daily, supplement) : null;
  const conflicts =
    intakeResults.filter((entry) => entry.conflicting).length +
    (dailyResult?.conflicting ? 1 : 0);
  const values = intakeResults.filter(
    (entry) => entry.result?.kind === "exact" && !entry.conflicting,
  );
  const subtotal = values.length
    ? sum(
        values.map(
          (entry) =>
            (entry.result!.value_decimal ?? entry.result!.value) as
              string | number,
        ),
      )
    : null;
  const exact = dailyResult?.conflicting
    ? null
    : dailyResult?.result?.kind === "exact"
      ? new Decimal(
          (dailyResult.result.value_decimal ?? dailyResult.result.value) as
            string | number,
        )
      : dailyResult
        ? null
        : conflicts
          ? null
          : subtotal;
  const groups = new Map<string, typeof values>();
  const keyForUnit = (unit: string | null) =>
    unit === "kJ" ? "energy_kj" : "energy_kcal";
  for (const entry of values) {
    const basis = ingredientBasis(entry.record, keyForUnit(entry.source_unit));
    groups.set(basis, [...(groups.get(basis) ?? []), entry]);
  }
  const compatible = groups.size <= 1;
  return {
    effective_result:
      dailyResult?.result ??
      (!daily && !conflicts && compatible && subtotal
        ? { kind: "exact", value: numericProjection(subtotal) }
        : null),
    ...representation(daily || compatible ? exact : null),
    basis: daily
      ? "reported_daily_total"
      : !compatible
        ? "incompatible_definition"
        : "known_intake_subtotal",
    unit: "kcal",
    source_ids: daily ? [daily.id] : values.map((entry) => entry.record.id),
    definition_basis: daily
      ? JSON.parse(
          ingredientBasis(daily, keyForUnit(dailyResult?.source_unit ?? null)),
        )
      : compatible && groups.size === 1
        ? JSON.parse([...groups.keys()][0]!)
        : null,
    reported_coverage: daily
      ? (object(
          object(daily.data.component_details)[
            keyForUnit(dailyResult?.source_unit ?? null)
          ],
        ).coverage ?? null)
      : null,
    known_intake_subtotal: {
      ...representation(compatible ? subtotal : null),
      source_ids: values.map((entry) => entry.record.id),
    },
    known_intake_subtotals: [...groups].map(([basis, entries]) => ({
      definition_basis: JSON.parse(basis),
      ...representation(
        sum(
          entries.map(
            (entry) =>
              (entry.result!.value_decimal ?? entry.result!.value) as
                string | number,
          ),
        ),
      ),
      source_ids: entries.map((entry) => entry.record.id),
    })),
    qualified_results: intakeResults
      .filter((entry) => entry.result && entry.result.kind !== "exact")
      .map((entry) => ({ source_id: entry.record.id, result: entry.result })),
    conflicting_source_ids: intakeResults
      .filter((entry) => entry.conflicting)
      .map((entry) => entry.record.id)
      .concat(dailyResult?.conflicting && daily ? [daily.id] : []),
    conversion_provenance: {
      kcal_per_kj: "1/4.184",
      selection: "prefer_supplied_kcal_when_consistent",
      consistency_tolerance: "max(1 kcal, 2% of supplied kcal)",
      stored_values_changed: false,
    },
    qualified_count:
      intakeResults.filter(
        (entry) => entry.result && entry.result.kind !== "exact",
      ).length +
      (dailyResult?.result && dailyResult.result.kind !== "exact" ? 1 : 0),
    missing_count: intakeResults.filter(
      (entry) => !entry.result && !entry.conflicting,
    ).length,
    estimated_count: usableRecords.filter((record) => {
      const result = energyResult(record, supplement);
      return (
        result.result &&
        valueKindAt(
          record,
          `/${supplement ? "nutrient_contributions" : "nutrients"}/${keyForUnit(result.source_unit)}`,
        ) === "estimated"
      );
    }).length,
    warnings: [
      ...(conflicts ? ["conflicting_representations"] : []),
      ...(!compatible ? ["incompatible_definition"] : []),
    ],
  };
}
function energyNutrientProjection(
  supplied: Data,
  canonicalEnergy: Data,
  key: string,
): Data {
  const outputUnit = key === "energy_kj" ? "kJ" : "kcal";
  const factor = outputUnit === "kJ" ? "4.184" : "1";
  const result: Data | null = canonicalEnergy.effective_result
    ? { ...object(canonicalEnergy.effective_result), unit: outputUnit }
    : null;
  if (result) {
    for (const field of ["value", "lower", "upper"]) {
      if (result[field] !== undefined) {
        const value = new Decimal(
          String(result[`${field}_decimal`] ?? result[field]),
        ).mul(factor);
        result[field] = numericProjection(value);
        result[`${field}_decimal`] = value.toFixed();
        if (field === "value" && result.kind === "exact")
          result.exact_decimal = value.toFixed();
      }
    }
  }
  const exact =
    canonicalEnergy.exact_decimal !== null
      ? new Decimal(String(canonicalEnergy.exact_decimal)).mul(factor)
      : null;
  return {
    ...supplied,
    ...representation(exact),
    effective_result: result,
    basis: canonicalEnergy.basis,
    definition_basis: canonicalEnergy.definition_basis,
    source_ids: canonicalEnergy.source_ids,
    reported_coverage: canonicalEnergy.reported_coverage,
    qualified_count: canonicalEnergy.qualified_count,
    missing_count: canonicalEnergy.missing_count,
    estimated_count: canonicalEnergy.estimated_count,
    warnings: canonicalEnergy.warnings,
    energy_projection: {
      derived_from: "nutrition.energy",
      canonical_unit: "kcal",
      output_unit: outputUnit,
      factor,
      stored_values_changed: false,
    },
  };
}
export function nutritionSummary(
  records: HealthRecord[],
  supplement = false,
): Data {
  const keys = nutrientKeys.filter((key) =>
    records.some(
      (record) =>
        key in
        object(
          record.data[supplement ? "nutrient_contributions" : "nutrients"],
        ),
    ),
  );
  const energyConcept = keys.some((key) => key.startsWith("energy_"))
    ? energy(records, supplement)
    : null;
  return {
    nutrients: Object.fromEntries(
      keys.map((key) => {
        const supplied = nutrient(records, key, supplement);
        return [
          key,
          key.startsWith("energy_") && energyConcept
            ? energyNutrientProjection(supplied, energyConcept, key)
            : supplied,
        ];
      }),
    ),
    energy: energyConcept,
    overlap_warnings: nonAdditiveGroups
      .filter((group) => group.filter((key) => keys.includes(key)).length > 1)
      .map((keys) => ({ code: "non_additive_components", keys })),
    record_count: records.length,
    source_ids: records.map((record) => record.id),
    provenance: records.map((record) => ({
      source_id: record.id,
      provenance: record.provenance,
      validity: record.validity,
    })),
  };
}
function fluidField(
  records: HealthRecord[],
  field: "water_ml" | "total_fluids_ml",
): Data {
  const tracked = records.filter((record) =>
    ["oral", "enteral"].includes(
      String(record.data.administration_route ?? "oral"),
    ),
  );
  const relevant = tracked.filter(
    (record) =>
      record.data.entry_kind === "daily_total" ||
      field !== "water_ml" ||
      record.data.drink_type === "water",
  );
  const eligible = relevant.filter((record) =>
    usable(
      record,
      record.data.entry_kind === "daily_total" ? `/${field}` : "/volume_ml",
    ),
  );
  const daily = eligible.find(
    (record) =>
      record.data.entry_kind === "daily_total" &&
      typeof record.data[field] === "number",
  );
  const drinks = eligible.filter(
    (record) => record.data.entry_kind === "intake",
  );
  const subtotal = drinks.length
    ? sum(drinks.map((record) => record.data.volume_ml as number))
    : null;
  return {
    ...representation(
      daily ? new Decimal(daily.data[field] as number) : subtotal,
    ),
    basis: daily ? "reported_daily_total" : "known_intake_subtotal",
    known_intake_subtotal: representation(subtotal),
    source_ids: daily ? [daily.id] : drinks.map((record) => record.id),
    missing_count: eligible.filter(
      (record) =>
        record.data.entry_kind === "daily_total" &&
        typeof record.data[field] !== "number",
    ).length,
    estimated_count: (daily ? [daily] : drinks).filter(
      (record) =>
        valueKindAt(
          record,
          record.data.entry_kind === "daily_total" ? `/${field}` : "/volume_ml",
        ) === "estimated",
    ).length,
    excluded_count: relevant.length - eligible.length,
    coverage: "tracked_oral_enteral_intake_only",
    warnings:
      records.length > tracked.length
        ? ["other_or_unknown_routes_excluded"]
        : [],
  };
}
export function hydrationSummary(records: HealthRecord[]): Data {
  return {
    total_fluids_ml: fluidField(records, "total_fluids_ml"),
    water_ml: fluidField(records, "water_ml"),
    other_route_records: records
      .filter(
        (record) =>
          record.data.administration_route === "other" ||
          record.data.administration_route === "unknown",
      )
      .map((record) => ({
        id: record.id,
        route: record.data.administration_route,
      })),
    source_ids: records.map((record) => record.id),
    provenance: records.map((record) => ({
      source_id: record.id,
      provenance: record.provenance,
      validity: record.validity,
    })),
  };
}
export function activitySummary(records: HealthRecord[]): Data {
  const workouts = records.filter(
    (record) => record.data.entry_kind === "workout" && usable(record),
  );
  const total = records.find(
    (record) => record.data.entry_kind === "daily_total" && usable(record),
  );
  const daily = object(total?.data.daily_totals);
  const fields = [
    "elapsed_seconds",
    "exercise_seconds",
    "distance_m",
    "steps",
    "energy_kcal",
  ];
  const subtotals = Object.fromEntries(
    fields.map((field) => {
      const values = workouts.filter(
        (record) =>
          typeof record.data[field] === "number" && usable(record, `/${field}`),
      );
      if (field === "energy_kcal") {
        const byBasis = Object.fromEntries(
          ["active", "gross", "unknown"].map((basis) => {
            const matching = values.filter(
              (record) =>
                record.data.energy_basis === basis &&
                usable(record, "/energy_basis"),
            );
            return [
              basis,
              {
                ...representation(
                  matching.length
                    ? sum(
                        matching.map((record) => record.data[field] as number),
                      )
                    : null,
                ),
                source_ids: matching.map((record) => record.id),
              },
            ];
          }),
        );
        return [field, byBasis];
      }
      return [
        field,
        {
          ...representation(
            values.length
              ? sum(values.map((record) => record.data[field] as number))
              : null,
          ),
          source_ids: values.map((record) => record.id),
        },
      ];
    }),
  );
  const safeDaily = Object.fromEntries(
    Object.entries(daily).filter(
      ([field]) => total && usable(total, `/daily_totals/${field}`),
    ),
  );
  return {
    workout_subtotals: subtotals,
    reported_daily_totals: total
      ? { source_id: total.id, values: safeDaily, provenance: total.provenance }
      : null,
    workouts: workouts.map((record) => ({
      source_id: record.id,
      activity_type: record.data.activity_type,
      data: Object.fromEntries(
        Object.entries(record.data).filter(([key]) =>
          usable(record, `/${key}`),
        ),
      ),
      provenance: record.provenance,
    })),
    basis: total
      ? "reported_daily_total_separate_from_workouts"
      : "known_workout_subtotal",
    warnings:
      total && workouts.length ? ["workouts_may_overlap_daily_total"] : [],
  };
}
export function overlaps(a: HealthRecord, b: HealthRecord): boolean {
  if (!a.occurred_at || !a.ended_at || !b.occurred_at || !b.ended_at)
    return false;
  return a.occurred_at < b.ended_at && b.occurred_at < a.ended_at;
}
export function studyPeriod(record: HealthRecord): Data {
  if (record.record_type === "intake") {
    if (record.data.effective_period)
      return object(record.data.effective_period);
    return {
      ...(record.data.start_at ? { start: record.data.start_at } : {}),
      ...(record.data.end_at ? { end: record.data.end_at } : {}),
      ...(record.data.duration_seconds !== undefined
        ? { duration_seconds: record.data.duration_seconds }
        : {}),
      time_precision:
        record.data.start_at || record.data.end_at ? "instant" : "duration",
      timezone: record.timezone,
    };
  }
  return object(
    record.data.effective_period ??
      record.data.collection_period ??
      object(record.data.study_metadata).effective_period,
  );
}
export function isStudy(record: HealthRecord): boolean {
  if (record.record_type === "intake") {
    if (record.data.effective_period) return true;
    if (record.data.start_at && record.data.end_at)
      return (
        localDate(String(record.data.start_at), record.timezone) !==
        localDate(String(record.data.end_at), record.timezone)
      );
    return Number(record.data.duration_seconds ?? 0) >= 86_400;
  }
  return (
    record.data.kind === "study_summary" ||
    record.data.entry_kind === "study_summary" ||
    !!record.data.collection_period
  );
}
export function periodOverlapsDate(
  record: HealthRecord,
  date: string,
): boolean {
  const period = studyPeriod(record);
  if (!period.start || !period.end) return record.occurred_on === date;
  const zone = String(period.timezone ?? record.timezone);
  const asDate = (value: unknown) =>
    String(value).includes("T")
      ? localDate(String(value), zone)
      : String(value);
  return asDate(period.start) <= date && asDate(period.end) >= date;
}
export function dailySummary(
  all: HealthRecord[],
  date: string,
  timezone: string,
  sections?: string[],
): Data {
  const records = all.filter(
    (record) =>
      record.occurred_on === date &&
      record.status === "active" &&
      !isStudy(record),
  );
  const selected = sections ?? [...recordTypes];
  const byType = (type: string) =>
    records.filter((record) => record.record_type === type);
  const payload: Data = {};
  if (selected.includes("nutrition"))
    payload.nutrition = nutritionSummary(byType("nutrition"));
  if (selected.includes("hydration"))
    payload.hydration = hydrationSummary(byType("hydration"));
  if (selected.includes("activity"))
    payload.activity = activitySummary(byType("activity"));
  const sessions = byType("sleep").filter((record) =>
    usable(record, "/sleep_seconds"),
  );
  const hasOverlap =
    sessions.some((a, index) =>
      sessions.slice(index + 1).some((b) => overlaps(a, b)),
    ) ||
    (sessions.length > 1 &&
      sessions.some((record) => !record.occurred_at || !record.ended_at));
  if (selected.includes("sleep"))
    payload.sleep = {
      sessions,
      ...representation(
        !hasOverlap &&
          sessions.some(
            (record) => typeof record.data.sleep_seconds === "number",
          )
          ? sum(
              sessions
                .filter(
                  (record) => typeof record.data.sleep_seconds === "number",
                )
                .map((record) => record.data.sleep_seconds as number),
            )
          : null,
      ),
      warnings: hasOverlap ? ["unresolved_session_overlap"] : [],
      basis: "supplied_sessions_only",
      source_ids: sessions.map((record) => record.id),
      missing_count: sessions.filter(
        (record) => typeof record.data.sleep_seconds !== "number",
      ).length,
      estimated_count: sessions.filter(
        (record) => valueKindAt(record, "/sleep_seconds") === "estimated",
      ).length,
      excluded_count: byType("sleep").length - sessions.length,
      coverage: "only_supplied_sessions",
    };
  const checkins = byType("checkin").filter((record) => usable(record));
  const overlappingStudies = all.filter(
    (record) =>
      record.status === "active" &&
      isStudy(record) &&
      periodOverlapsDate(record, date),
  );
  const completeness: Data = Object.fromEntries(
    recordTypes.map((type) => [type, { value: "unknown", source_id: null }]),
  );
  for (const record of [...checkins].sort(
    (a, b) =>
      Date.parse(
        String(object(a.data.diary_completeness).reported_at ?? a.recorded_at),
      ) -
        Date.parse(
          String(
            object(b.data.diary_completeness).reported_at ?? b.recorded_at,
          ),
        ) ||
      Date.parse(a.recorded_at) - Date.parse(b.recorded_at) ||
      a.id.localeCompare(b.id),
  )) {
    for (const [key, value] of Object.entries(
      object(record.data.diary_completeness),
    ))
      if (
        recordTypes.includes(key as (typeof recordTypes)[number]) &&
        usable(record, `/diary_completeness/${key}`)
      )
        completeness[key] = {
          value,
          source_id: record.id,
          reported_at: object(record.data.diary_completeness).reported_at,
        };
  }
  if (selected.includes("checkin")) {
    const latestMood = checkins
      .filter(
        (record) =>
          usable(record, "/mood") &&
          moodValues.some((value) => value === record.data.mood),
      )
      .sort(
        (a, b) =>
          Date.parse(b.occurred_at ?? b.recorded_at) -
            Date.parse(a.occurred_at ?? a.recorded_at) ||
          Date.parse(b.recorded_at) - Date.parse(a.recorded_at) ||
          b.id.localeCompare(a.id),
      )[0];
    payload.checkin = {
      observations: checkins,
      rating_aggregation: "individual_supplied_observations",
      latest_mood: latestMood
        ? {
            value: latestMood.data.mood,
            source_id: latestMood.id,
            occurred_at: latestMood.occurred_at,
            recorded_at: latestMood.recorded_at,
          }
        : null,
    };
  }
  if (selected.includes("intake"))
    payload.intake = {
      events: byType("intake"),
      supplement_nutrients: nutritionSummary(
        byType("intake").filter(
          (record) =>
            record.data.status === "taken" ||
            record.data.status === "partially_taken",
        ),
        true,
      ),
      combined_dietary_supplement_total: null,
    };
  if (selected.includes("measurement"))
    payload.measurement = byType("measurement").filter((record) =>
      usable(record),
    );
  if (selected.includes("lab_result"))
    payload.lab_result = byType("lab_result");
  return {
    catalog_version: CATALOG_VERSION,
    date,
    timezone,
    ...payload,
    diary_completeness: completeness,
    overlapping_studies: overlappingStudies.map((record) => ({
      source_id: record.id,
      record_type: record.record_type,
      period: studyPeriod(record),
      labelled_as:
        record.record_type === "intake"
          ? "overlapping_interval_intake"
          : "overlapping_interval_study",
    })),
    quality_exclusions: {
      records: records.filter((record) => !usable(record)).length,
      preliminary: records.filter(
        (record) => record.data.source_status === "preliminary",
      ).length,
      cancelled: records.filter(
        (record) => record.data.source_status === "cancelled",
      ).length,
      suspect_invalid: records.filter((record) => record.validity !== "valid")
        .length,
    },
    warnings: [
      ...(hasOverlap ? ["unresolved_session_overlap"] : []),
      ...(overlappingStudies.some((record) => {
        const period = studyPeriod(record);
        return !period.start || !period.end;
      })
        ? ["unresolved_interval_coverage"]
        : []),
    ],
    source_ids: records.map((record) => record.id),
  };
}
