import { afterEach, expect, test } from "vitest";
import { database } from "../src/db/client.js";
import { Cursors } from "../src/domain/cursor.js";
import { Reads } from "../src/domain/reads.js";
import { Store } from "../src/domain/store.js";
import {
  dailySummary,
  nutritionSummary,
  periodOverlapsDate,
  point,
} from "../src/domain/summary.js";
import { normalizeInput } from "../src/domain/validation.js";
import {
  object,
  type Data,
  type HealthRecord,
  type RecordInput,
} from "../src/domain/types.js";
import { operations } from "../src/registry/operations.js";
import { base, fixtureDate, record } from "./fixtures.js";

const connections: ReturnType<typeof database>[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map(({ pool }) => pool.end()));
});
function saved(
  type: HealthRecord["record_type"],
  data: Data,
  input: Partial<RecordInput> = {},
): HealthRecord {
  const { warnings: _warnings, ...normalized } = normalizeInput(
    type,
    { ...base, ...input, data },
    "Asia/Kolkata",
    new Date("2026-10-02T00:00:00Z"),
  );
  return record(type, normalized.data, normalized);
}
function readsOf(records: HealthRecord[]): Reads {
  const connection = database("postgres://fixture@127.0.0.1:9/unused");
  connections.push(connection);
  const reads = new Reads(
    new Store(connection.db, "Asia/Kolkata"),
    new Cursors("synthetic-summary-test-secret"),
  );
  Reflect.set(reads, "window", async () => records);
  return reads;
}
async function trend(records: HealthRecord[], metric: string): Promise<Data> {
  const result = await readsOf(records).trends({
    metrics: [metric],
    start_date: fixtureDate,
    end_date: fixtureDate,
  });
  const schema = operations.find(
    (operation) => operation.name === "health_get_trends",
  )!.output;
  expect(schema.safeParse(result).success).toBe(true);
  return object((result.metrics as Data[])[0]);
}
const daily = (records: HealthRecord[], date = fixtureDate) =>
  dailySummary(records, date, "Asia/Kolkata");

test("Other/unknown route totals cannot override tracked oral/enteral hydration", () => {
  for (const administration_route of ["other", "unknown"]) {
    const drink = saved("hydration", {
      entry_kind: "intake",
      volume_ml: 250,
      drink_type: "water",
      administration_route: "oral",
    });
    const total = saved("hydration", {
      entry_kind: "daily_total",
      total_fluids_ml: 1000,
      water_ml: 300,
      administration_route,
    });
    const result = object(daily([drink, total]).hydration);
    expect(object(result.total_fluids_ml).exact_value).toBe(250);
    expect(object(result.water_ml).exact_value).toBe(250);
    expect(object(result.total_fluids_ml).source_ids).toEqual([drink.id]);
    expect(object(result.total_fluids_ml).warnings).toContain(
      "other_or_unknown_routes_excluded",
    );
    expect(result.other_route_records).toEqual([
      { id: total.id, route: administration_route },
    ]);
  }
});
test("Hydration preserves inherited estimates and reports invalid volume exclusions", () => {
  const estimated = saved(
    "hydration",
    { entry_kind: "intake", volume_ml: 200, drink_type: "tea" },
    {
      provenance: {
        ...base.provenance,
        field_overrides: { "/volume_ml": { value_kind: "estimated" } },
      },
    },
  );
  const invalid = saved(
    "hydration",
    { entry_kind: "intake", volume_ml: 300, drink_type: "water" },
    {
      provenance: {
        ...base.provenance,
        field_overrides: { "/volume_ml": { validity: "invalid" } },
      },
    },
  );
  const hydration = object(daily([estimated, invalid]).hydration);
  expect(object(hydration.total_fluids_ml).exact_value).toBe(200);
  expect(object(hydration.total_fluids_ml).estimated_count).toBe(1);
  expect(object(hydration.total_fluids_ml).excluded_count).toBe(1);
  expect(hydration.provenance).toHaveLength(2);
  expect(object(hydration.water_ml).exact_value).toBeNull();
});
test("Latest explicit completeness compares UTC instants across supplied offsets", () => {
  const older = saved("checkin", {
    diary_completeness: {
      reported_at: "2026-09-10T14:00:00+05:30",
      nutrition: "complete",
    },
  });
  const newer = saved("checkin", {
    diary_completeness: {
      reported_at: "2026-09-10T10:00:00Z",
      nutrition: "partial",
    },
  });
  for (const records of [
    [older, newer],
    [newer, older],
  ]) {
    const completeness = object(
      object(daily(records).diary_completeness).nutrition,
    );
    expect(completeness.value).toBe("partial");
    expect(completeness.source_id).toBe(newer.id);
  }
});
test("Dual energy interval endpoint semantics must agree before selection", () => {
  const meal = saved("nutrition", {
    entry_kind: "intake",
    nutrients: { energy_kcal: 50 },
  });
  const total = saved("nutrition", {
    entry_kind: "daily_total",
    nutrients: { energy_kcal: null, energy_kj: null },
    nutrient_qualifiers: {
      energy_kcal: {
        kind: "interval",
        lower: 100,
        upper: 200,
        unit: "kcal",
        lower_inclusive: true,
        upper_inclusive: true,
      },
      energy_kj: {
        kind: "interval",
        lower: 418.4,
        upper: 836.8,
        unit: "kJ",
        lower_inclusive: false,
        upper_inclusive: true,
      },
    },
  });
  const energy = object(nutritionSummary([meal, total]).energy);
  expect(energy.effective_result).toBeNull();
  expect(energy.exact_value).toBeNull();
  expect(energy.warnings).toContain("conflicting_representations");
  expect(energy.conflicting_source_ids).toContain(total.id);
});
test("Outer comparators cannot turn a qualified typed quantity into a point", () => {
  expect(point({ kind: "quantity", value: "5", unit: "kg" }, "lt")).toBeNull();
  expect(
    point({ kind: "quantity", value: "5", unit: "kg", comparator: "lt" }),
  ).toBeNull();
  expect(
    point({ kind: "quantity", value: "5", unit: "kg" }, "eq")?.toFixed(),
  ).toBe("5");
});
test("Invalid nutrient qualifier affects its nutrient while independent values remain usable", () => {
  const intake = saved(
    "nutrition",
    {
      entry_kind: "intake",
      nutrients: { protein_g: 5, fat_g: 2 },
      nutrient_qualifiers: { protein_g: { kind: "bound", comparator: "lt" } },
    },
    {
      provenance: {
        ...base.provenance,
        field_overrides: {
          "/nutrient_qualifiers/protein_g/comparator": { validity: "invalid" },
        },
      },
    },
  );
  const nutrients = object(nutritionSummary([intake]).nutrients);
  expect(object(nutrients.protein_g).qualified_results).toEqual([]);
  expect(object(nutrients.protein_g).excluded_count).toBe(1);
  expect(object(nutrients.fat_g).exact_value).toBe(2);
});
test("A supplied daily coverage label remains separate from computed field coverage", () => {
  const total = saved("nutrition", {
    entry_kind: "daily_total",
    nutrients: { carbohydrate_g: 10, energy_kj: 418.4 },
    component_details: {
      carbohydrate_g: {
        expression_basis: "available",
        coverage: "Source covers supplied consumed entries",
      },
      energy_kj: { coverage: "Source-reported whole day" },
    },
  });
  const nutrition = nutritionSummary([total]);
  expect(
    object(object(nutrition.nutrients).carbohydrate_g).reported_coverage,
  ).toBe("Source covers supplied consumed entries");
  expect(object(nutrition.energy).reported_coverage).toBe(
    "Source-reported whole day",
  );
});
test("Multiday administration retains its period and is never charged to its start day", () => {
  const intake = saved("intake", {
    product_name: "Synthetic administration",
    category: "medication",
    status: "taken",
    start_at: "2026-09-10T10:00:00+05:30",
    end_at: "2026-09-11T10:00:00+05:30",
    nutrient_contributions: { iron_mg: 10 },
  });
  for (const date of ["2026-09-10", "2026-09-11"]) {
    const result = daily([intake], date);
    expect(object(result.intake).events).toEqual([]);
    expect(
      object(object(result.intake).supplement_nutrients).nutrients,
    ).toEqual({});
    const interval = object((result.overlapping_studies as Data[])[0]);
    expect(interval.labelled_as).toBe("overlapping_interval_intake");
    expect(interval.source_id).toBe(intake.id);
    expect(object(interval.period).start).toBe("2026-09-10T10:00:00+05:30");
  }
});
test("A same-day administered dose remains an actual day's contribution", () => {
  const intake = saved("intake", {
    product_name: "Synthetic administration",
    category: "medication",
    status: "taken",
    start_at: "2026-09-10T10:00:00+05:30",
    end_at: "2026-09-10T11:00:00+05:30",
    nutrient_contributions: { iron_mg: 10 },
  });
  expect(
    object(
      object(
        object(object(daily([intake]).intake).supplement_nutrients).nutrients,
      ).iron_mg,
    ).exact_value,
  ).toBe(10);
});
test("Qualified-only trend days retain supplied forms and source metadata with null numeric points", async () => {
  const intake = saved(
    "nutrition",
    {
      entry_kind: "intake",
      nutrients: { fiber_g: 0.5 },
      nutrient_qualifiers: { fiber_g: { kind: "bound", comparator: "lt" } },
    },
    { provenance: { ...base.provenance, value_kind: "estimated" } },
  );
  const result = await trend([intake], "nutrient:fiber_g");
  const series = object((result.series as Data[])[0]);
  const observation = object((series.observations as Data[])[0]);
  expect(observation.value).toBeNull();
  expect(observation.qualified_count).toBe(1);
  expect(observation.estimated_count).toBe(1);
  expect(observation.qualified_results).toHaveLength(1);
  expect(observation.provenance).toEqual([
    { source_id: intake.id, provenance: intake.provenance, validity: "valid" },
  ]);
  expect(object((series.points as Data[])[0]).value).toBeNull();
  expect(result.exclusions).toBe(1);
});
test("Incompatible expression bases remain separate numerical trend subtotals", async () => {
  const unknown = saved("nutrition", {
    entry_kind: "intake",
    nutrients: { carbohydrate_g: 5 },
  });
  const available = saved("nutrition", {
    entry_kind: "intake",
    nutrients: { carbohydrate_g: 6 },
    component_details: { carbohydrate_g: { expression_basis: "available" } },
  });
  const result = await trend([unknown, available], "nutrient:carbohydrate_g");
  const series = result.series as Data[];
  expect(series).toHaveLength(2);
  expect(
    series.map((entry) => object((entry.points as Data[])[0]).value).sort(),
  ).toEqual([5, 6]);
  expect(series.map((entry) => object(entry.identity).unit)).toEqual([
    "g",
    "g",
  ]);
  expect(result.warnings).toContain("incompatible_definition");
});
test("Sleep trends retain contributing source IDs and estimated provenance", async () => {
  const sleep = saved(
    "sleep",
    { entry_kind: "session", session_type: "main", sleep_seconds: 7200 },
    { provenance: { ...base.provenance, value_kind: "estimated" } },
  );
  const result = await trend([sleep], "sleep:sleep_seconds");
  const series = object((result.series as Data[])[0]);
  expect(object((series.points as Data[])[0]).source_ids).toEqual([sleep.id]);
  expect(object((series.observations as Data[])[0]).estimated_count).toBe(1);
  expect(object(series.identity).unit).toBe("s");
});
test("A real zero daily activity total overrides workouts without reclassifying gross calories", async () => {
  const workout = saved("activity", {
    entry_kind: "workout",
    activity_type: "walking",
    steps: 100,
    energy_kcal: 50,
    energy_basis: "gross",
  });
  const total = saved("activity", {
    entry_kind: "daily_total",
    daily_totals: { steps: 0 },
  });
  const steps = await trend([workout, total], "activity:steps");
  const stepSeries = object((steps.series as Data[])[0]);
  expect(object((stepSeries.points as Data[])[0]).value).toBe(0);
  expect(object((stepSeries.points as Data[])[0]).source_ids).toEqual([
    total.id,
  ]);
  const energy = await trend([workout], "activity:active_energy_kcal");
  const energySeries = object((energy.series as Data[])[0]);
  expect(object((energySeries.points as Data[])[0]).value).toBeNull();
});
test("Invalid typed quantity units prevent ordinary numeric trends", async () => {
  const measurement = saved(
    "measurement",
    {
      kind: "scalar",
      metric_key: "weight",
      value: { kind: "quantity", value: "50", unit: "kg" },
    },
    {
      provenance: {
        ...base.provenance,
        field_overrides: { "/value/unit": { validity: "invalid" } },
      },
    },
  );
  const result = await trend([measurement], "measurement:weight");
  expect(result.exclusions).toBe(1);
  const series = object((result.series as Data[])[0]);
  expect(object((series.points as Data[])[0]).value).toBeNull();
  expect(object((series.observations as Data[])[0]).supplied_result).toEqual(
    measurement.data.value,
  );
});
test("Observed period dates use their supplied timezone instead of the report date", () => {
  const study = saved(
    "measurement",
    {
      kind: "study_summary",
      study_type: "cgm_summary",
      components: {},
      effective_period: {
        start: "2026-09-09T20:00:00Z",
        end: "2026-09-10T01:00:00Z",
        time_precision: "instant",
        timezone: "Asia/Kolkata",
      },
    },
    { occurred_on: "2026-09-12" },
  );
  expect(periodOverlapsDate(study, "2026-09-09")).toBe(false);
  expect(periodOverlapsDate(study, "2026-09-10")).toBe(true);
  expect(periodOverlapsDate(study, "2026-09-12")).toBe(false);
});
test("Computed decimal overflow remains exact decimal text across summaries and averages", async () => {
  const records = [1, 2].map(() =>
    saved("nutrition", {
      entry_kind: "intake",
      nutrients: { protein_g: 1e308 },
    }),
  );
  const expected = "2" + "0".repeat(308);
  const result = daily(records);
  const protein = object(object(object(result.nutrition).nutrients).protein_g);
  expect(protein.exact_value).toBe(expected);
  expect(object(protein.effective_result).value).toBe(expected);
  expect(
    operations
      .find((operation) => operation.name === "health_get_daily_summary")!
      .output.safeParse(result).success,
  ).toBe(true);
  const history = await readsOf(records).trends({
    metrics: ["nutrient:protein_g"],
    start_date: fixtureDate,
    end_date: fixtureDate,
    granularity: "week",
  });
  expect(
    operations
      .find((operation) => operation.name === "health_get_trends")!
      .output.safeParse(history).success,
  ).toBe(true);
  expect(
    object(
      (
        object((object((history.metrics as Data[])[0]).series as Data[])[0])
          .points as Data[]
      )[0],
    ).value,
  ).toBe(expected);
});
test("Energy summary aliases share canonical daily precedence and conflicting-value suppression", () => {
  const intake = saved("nutrition", {
    entry_kind: "intake",
    nutrients: { energy_kcal: 100 },
  });
  const total = saved("nutrition", {
    entry_kind: "daily_total",
    nutrients: { energy_kj: 836.8 },
  });
  const nutrition = nutritionSummary([intake, total]);
  const perUnit = object(nutrition.nutrients);
  expect(object(perUnit.energy_kcal).exact_value).toBe(200);
  expect(object(perUnit.energy_kj).exact_value).toBe(836.8);
  expect(object(perUnit.energy_kcal).source_ids).toEqual([total.id]);
  expect(
    object((object(perUnit.energy_kcal).known_intake_subtotals as Data[])[0])
      .exact_value,
  ).toBe(100);
  expect(object(object(perUnit.energy_kj).energy_projection).factor).toBe(
    "4.184",
  );
  const conflicting = saved("nutrition", {
    entry_kind: "daily_total",
    nutrients: { energy_kcal: 100, energy_kj: 9000 },
  });
  const conflict = object(nutritionSummary([intake, conflicting]).nutrients);
  expect(object(conflict.energy_kcal).exact_value).toBeNull();
  expect(object(conflict.energy_kj).exact_value).toBeNull();
  expect(object(conflict.energy_kcal).warnings).toContain(
    "conflicting_representations",
  );
});
test("Study component projections preserve their own estimate and validity metadata", async () => {
  const study = saved("measurement", {
    kind: "study_summary",
    study_type: "body_composition_summary",
    effective_period: {
      start: fixtureDate,
      end: fixtureDate,
      time_precision: "date",
    },
    components: {
      weight: {
        value: 50,
        unit: "kg",
        validity: "suspect",
        provenance: {
          value_kind: "estimated",
          uncertainty_note: "Supplied estimate",
        },
      },
    },
  });
  const result = await trend([study], "measurement:weight");
  const series = object((result.series as Data[])[0]);
  const observation = object((series.observations as Data[])[0]);
  expect(observation.component_path).toBe("/components/weight/value");
  expect(object(observation.provenance).value_kind).toBe("estimated");
  expect(object(observation.component_provenance).uncertainty_note).toBe(
    "Supplied estimate",
  );
  expect(observation.component_validity).toBe("suspect");
  expect(series.points).toEqual([]);
});
