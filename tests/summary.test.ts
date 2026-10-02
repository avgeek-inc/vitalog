import { expect, test } from "vitest";
import { dailySummary, nutritionSummary } from "../src/domain/summary.js";
import { object } from "../src/domain/types.js";
import { record, fixtureDate } from "./fixtures.js";

const nutrients = (result: unknown) => object(object(result).nutrients);
test("Exact decimal sums, zero, sparse coverage and daily precedence", () => {
  const meals = [
    record("nutrition", {
      entry_kind: "intake",
      nutrients: { protein_g: 0.1, energy_kcal: 100 },
    }),
    record("nutrition", {
      entry_kind: "intake",
      nutrients: { protein_g: 0.2, fiber_g: null, energy_kcal: 200 },
    }),
  ];
  expect(
    object(nutrients(nutritionSummary(meals)).protein_g).exact_decimal,
  ).toBe("0.3");
  const total = record("nutrition", {
    entry_kind: "daily_total",
    nutrients: { protein_g: 0, energy_kcal: 1900 },
  });
  expect(
    object(nutrients(nutritionSummary([...meals, total])).protein_g)
      .exact_value,
  ).toBe(0);
  expect(
    object(object(nutritionSummary([...meals, total])).energy).exact_value,
  ).toBe(1900);
  expect(nutrients(nutritionSummary(meals))).not.toHaveProperty("sodium_mg");
});
test("Bounds and intervals override without exact fallback; plain null does not", () => {
  const meal = record("nutrition", {
    entry_kind: "intake",
    nutrients: { added_sugars_g: 2, protein_g: 5, fiber_g: 4 },
  });
  const total = record("nutrition", {
    entry_kind: "daily_total",
    nutrients: { added_sugars_g: 0.5, protein_g: null, fiber_g: null },
    nutrient_qualifiers: {
      added_sugars_g: { kind: "bound", comparator: "lt" },
      fiber_g: { kind: "interval", lower: 3, upper: 8, unit: "g" },
    },
  });
  const result = nutrients(nutritionSummary([meal, total]));
  expect(object(result.added_sugars_g).exact_value).toBeNull();
  expect(object(result.added_sugars_g).basis).toBe("reported_daily_total");
  expect(object(result.fiber_g).exact_value).toBeNull();
  expect(object(result.protein_g).exact_value).toBe(5);
});
test("Energy representations select one amount and qualified kJ total overrides kcal meals", () => {
  const meal = record("nutrition", {
    entry_kind: "intake",
    nutrients: { energy_kcal: 100, energy_kj: 418.4 },
  });
  expect(object(nutritionSummary([meal]).energy).exact_value).toBe(100);
  const total = record("nutrition", {
    entry_kind: "daily_total",
    nutrients: { energy_kj: 836.8 },
  });
  expect(object(nutritionSummary([meal, total]).energy).exact_value).toBe(200);
  const bound = record("nutrition", {
    entry_kind: "daily_total",
    nutrients: { energy_kj: 836.8 },
    nutrient_qualifiers: { energy_kj: { kind: "bound", comparator: "lt" } },
  });
  expect(object(nutritionSummary([meal, bound]).energy).exact_value).toBeNull();
  const conflicting = record("nutrition", {
    entry_kind: "daily_total",
    nutrients: { energy_kcal: 100, energy_kj: 9000 },
  });
  expect(
    object(nutritionSummary([meal, conflicting]).energy).exact_value,
  ).toBeNull();
  expect(object(nutritionSummary([conflicting]).energy).warnings).toContain(
    "conflicting_representations",
  );
});
test("Unknown and known expression bases keep separate subtotals", () => {
  const records = [
    record("nutrition", {
      entry_kind: "intake",
      nutrients: { carbohydrate_g: 5 },
    }),
    record("nutrition", {
      entry_kind: "intake",
      nutrients: { carbohydrate_g: 6 },
      component_details: { carbohydrate_g: { expression_basis: "available" } },
    }),
  ];
  const carb = object(nutrients(nutritionSummary(records)).carbohydrate_g);
  expect(carb.basis).toBe("incompatible_definition");
  expect(carb.exact_value).toBeNull();
  expect(carb.known_intake_subtotals).toHaveLength(2);
});
test("Definition versions, fiber methods, selected kJ context and parent estimate overrides survive summaries", () => {
  const fiber = [
    record("nutrition", {
      entry_kind: "intake",
      nutrients: { fiber_g: 2 },
      fiber_method: "Supplied method A",
    }),
    record("nutrition", {
      entry_kind: "intake",
      nutrients: { fiber_g: 3 },
      fiber_method: "Supplied method B",
    }),
  ];
  expect(object(nutrients(nutritionSummary(fiber)).fiber_g).basis).toBe(
    "incompatible_definition",
  );
  const versions = ["1", "2"].map((version) =>
    record("nutrition", {
      entry_kind: "intake",
      nutrients: { carbohydrate_g: 2 },
      component_details: {
        carbohydrate_g: {
          definition: "Supplied definition",
          definition_version: version,
        },
      },
    }),
  );
  expect(
    object(nutrients(nutritionSummary(versions)).carbohydrate_g).exact_value,
  ).toBeNull();
  const kj = record(
    "nutrition",
    {
      entry_kind: "daily_total",
      nutrients: { energy_kj: 418.4 },
      component_details: { energy_kj: { expression_basis: "Supplied basis" } },
    },
    {
      provenance: {
        source_type: "manual",
        value_kind: "reported",
        field_overrides: { "/nutrients": { value_kind: "estimated" } },
      },
    },
  );
  const summary = nutritionSummary([kj]);
  expect(object(object(summary.energy).definition_basis).expression_basis).toBe(
    "Supplied basis",
  );
  expect(object(summary.energy).estimated_count).toBe(1);
  expect(object(nutrients(summary).energy_kj).estimated_count).toBe(1);
});
test("Hydration and workouts retain non-additive whole-day coverage and field validity", () => {
  const records = [
    record("hydration", {
      entry_kind: "intake",
      volume_ml: 250,
      drink_type: "water",
    }),
    record("hydration", {
      entry_kind: "daily_total",
      total_fluids_ml: 1000,
      water_ml: 500,
    }),
    record(
      "activity",
      {
        entry_kind: "workout",
        activity_type: "walking",
        elapsed_seconds: 600,
        energy_kcal: 40,
        energy_basis: "gross",
        average_heart_rate_bpm: 120,
      },
      {
        provenance: {
          source_type: "manual",
          value_kind: "estimated",
          field_overrides: {
            "/average_heart_rate_bpm": { validity: "invalid" },
          },
        },
      },
    ),
    record("activity", {
      entry_kind: "daily_total",
      daily_totals: { active_energy_kcal: 400 },
    }),
  ];
  const day = dailySummary(records, fixtureDate, "Asia/Kolkata");
  expect(object(object(day.hydration).total_fluids_ml).exact_value).toBe(1000);
  expect(object(object(day.hydration).water_ml).exact_value).toBe(500);
  expect(
    object((object(day.activity).workouts as { data: object }[])[0]!.data),
  ).not.toHaveProperty("average_heart_rate_bpm");
  expect(object(day.activity).warnings).toContain(
    "workouts_may_overlap_daily_total",
  );
});
test("Overlapping sleep, independent completeness, supplements and interval studies", () => {
  const sleep = record(
    "sleep",
    { entry_kind: "session", session_type: "main", sleep_seconds: 100 },
    { occurred_at: "2026-09-10T01:00:00Z", ended_at: "2026-09-10T03:00:00Z" },
  );
  const overlap = record(
    "sleep",
    { entry_kind: "session", session_type: "nap", sleep_seconds: 50 },
    { occurred_at: "2026-09-10T02:00:00Z", ended_at: "2026-09-10T04:00:00Z" },
  );
  const study = record("measurement", {
    kind: "study_summary",
    study_type: "cgm_summary",
    components: {},
    effective_period: {
      start: "2026-09-01",
      end: "2026-09-15",
      time_precision: "date",
    },
  });
  const supplement = record("intake", {
    product_name: "Supplied",
    category: "supplement",
    status: "taken",
    nutrient_contributions: { protein_g: 1 },
  });
  const day = dailySummary(
    [sleep, overlap, study, supplement],
    fixtureDate,
    "Asia/Kolkata",
  );
  expect(object(day.sleep).exact_value).toBeNull();
  expect(day.overlapping_studies).toHaveLength(1);
  expect(object(day.intake).combined_dietary_supplement_total).toBeNull();
  expect(object(object(day.diary_completeness).nutrition).value).toBe(
    "unknown",
  );
});
