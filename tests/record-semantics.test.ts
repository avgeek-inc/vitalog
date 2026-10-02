import { describe, expect, test } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createRequire } from "node:module";
import type { FormatsPlugin } from "ajv-formats";
import {
  normalizeInput,
  readStoredSnapshot,
} from "../src/domain/validation.js";
import {
  recordInputs,
  recordInputSchemas,
  recordSchemas,
} from "../src/registry/records.js";
import { jsonSchema } from "../src/registry/primitives.js";
import { recordTypes, type RecordType } from "../src/registry/definitions.js";
import { base, examples, labFixture, measurementFixture } from "./fixtures.js";
import type { Data } from "../src/domain/types.js";
import { DomainError } from "../src/errors.js";

const now = new Date("2026-10-02T00:00:00Z");
const normalize = (type: RecordType, data: Data, envelope: Data = {}) =>
  normalizeInput(type, { ...base, ...envelope, data }, "UTC", now);
const ajv = new Ajv2020({ strict: false });
const addFormats: FormatsPlugin = createRequire(import.meta.url)("ajv-formats");
addFormats(ajv);
const measurementSchema = ajv.compile(
  jsonSchema(recordInputSchemas.measurement),
);
const labSchema = ajv.compile(jsonSchema(recordInputSchemas.lab_result));

describe("Fresh request contracts and preserved stored payloads", () => {
  for (const type of recordTypes.filter((value) => value !== "lab_result"))
    test(`${type} requires an explicit date in its published input contract`, () => {
      const { occurred_on: _date, ...input } = examples[type];
      expect(recordInputs[type].safeParse(input).success).toBe(false);
      expect(ajv.compile(jsonSchema(recordInputs[type]))(input)).toBe(false);
      expect(() => normalizeInput(type, input, "UTC", now)).toThrow();
    });

  test.each([
    { ...measurementFixture("weight"), unit: "bananas" },
    { ...measurementFixture("weight"), value: "-1.5" },
    { ...measurementFixture("weight"), unit: undefined },
    {
      ...measurementFixture("weight"),
      value: { kind: "coded", display: "High" },
    },
    { ...measurementFixture("visual_acuity_snellen"), value: 160 },
    {
      ...measurementFixture("hearing_threshold"),
      classification_metadata: undefined,
    },
    { ...measurementFixture("segmental_fat_mass"), laterality: undefined },
  ])("Measurement JSON Schema and runtime reject invalid shape %#", (data) => {
    expect(
      measurementSchema(data),
      JSON.stringify(measurementSchema.errors),
    ).toBe(false);
    expect(() => normalize("measurement", data)).toThrow();
  });

  test.each([
    {
      ...labFixture("hemoglobin"),
      result: { kind: "text", text: "Wrong shape" },
    },
    {
      ...labFixture("ana_titer"),
      result: { kind: "quantity", value: 160, unit: "1" },
    },
    {
      ...labFixture("pathogen_nucleic_acid"),
      result: {
        kind: "pathogen_result",
        result: { kind: "coded", display: "Negative" },
      },
    },
    {
      ...labFixture("blood_glucose"),
      result: { kind: "interval", lower: 3, upper: 4 },
    },
    {
      ...labFixture("antimicrobial_susceptibility"),
      result: {
        kind: "susceptibility_result",
        isolate_reference: "A",
        antimicrobial: "Supplied antimicrobial",
        disk_zone: { kind: "quantity", value: "-1", unit: "mm" },
        interpretation: "Supplied interpretation",
      },
    },
  ])("Lab JSON Schema and runtime reject invalid shape %#", (data) => {
    expect(labSchema(data), JSON.stringify(labSchema.errors)).toBe(false);
    expect(() => normalize("lab_result", data)).toThrow();
  });

  test.each([
    { mic: { kind: "quantity", value: "0.500" }, unit: "ug/mL" },
    { disk_zone: { kind: "quantity", value: "12.00" }, unit: "mm" },
  ])(
    "A single susceptibility quantity retains its outer source unit %#",
    (value) => {
      const { unit, ...quantity } = value;
      const data = {
        ...labFixture("antimicrobial_susceptibility"),
        unit,
        result: {
          kind: "susceptibility_result",
          isolate_reference: "A",
          antimicrobial: "Supplied antimicrobial",
          interpretation: "Supplied interpretation",
          ...quantity,
        },
      };
      expect(labSchema(data), JSON.stringify(labSchema.errors)).toBe(true);
      expect(normalize("lab_result", data).data).toEqual(data);
    },
  );

  test.each([
    {
      ...measurementFixture("weight"),
      value: { kind: "quantity", value: "51.500", unit: "kg" },
      unit: undefined,
    },
    {
      ...measurementFixture("weight"),
      value: { kind: "quantity", value: "51.500" },
    },
    {
      ...measurementFixture("weight"),
      value: { kind: "interval", lower: "51.0", upper: "52.0", unit: "kg" },
      unit: undefined,
    },
    {
      kind: "scalar",
      metric_key: "hearing_threshold",
      value: { kind: "absent", reason: "not_performed" },
    },
  ])(
    "Typed scalar values keep either explicit unit location and absence %#",
    (data) => {
      expect(
        measurementSchema(data),
        JSON.stringify(measurementSchema.errors),
      ).toBe(true);
      expect(normalize("measurement", data).data).toEqual(data);
    },
  );

  test("Tightened fresh inputs do not reinterpret stored schema-two snapshots", () => {
    const prior = {
      ...measurementFixture("weight"),
      value: { kind: "ratio", numerator: 1, denominator: 2 },
      unit: "supplied_unit",
    };
    expect(recordSchemas.measurement.safeParse(prior).success).toBe(true);
    expect(recordInputSchemas.measurement.safeParse(prior).success).toBe(false);
    expect(readStoredSnapshot(prior, 2)).toEqual(prior);
    const old = {
      entry_kind: "intake",
      nutrients: { folate_ug: 100 },
      old_basis: "Unknown",
    };
    expect(readStoredSnapshot(old, 1)).toEqual(old);
  });

  test.each([
    [
      "measurement",
      { ...measurementFixture("weight"), metric_key: "unknown_metric" },
      "/data/metric_key",
      "measurements",
    ],
    [
      "lab_result",
      { ...labFixture("hemoglobin"), analyte_key: "unknown_analyte" },
      "/data/analyte_key",
      "lab_analytes",
    ],
  ] as const)(
    "Unknown %s identity has a writable-field discovery hint",
    (type, data, path, category) => {
      try {
        normalize(type, data);
        throw new Error("Expected validation to reject unknown identity");
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        expect(error.issues.find((issue) => issue.path === path)).toMatchObject(
          {
            path,
            discovery: { arguments: { category } },
          },
        );
      }
    },
  );
});

describe("Source periods, precision and original timestamps", () => {
  test.each([
    ["2026-09-10T23:00:00-12:00", "2026-09-11T00:00:00+14:00"],
    ["2026-09-10T19:00:00Z", "2026-09-10T23:00:00+05:30"],
  ])(
    "Nested periods reject inverted instants despite printable order",
    (start, end) => {
      expect(() =>
        normalize("measurement", {
          ...measurementFixture("cgm_summary"),
          effective_period: { start, end, time_precision: "instant" },
        }),
      ).toThrow();
      expect(() =>
        normalize("sleep", {
          ...examples.sleep.data,
          stage_intervals: [{ stage: "REM", start_at: start, end_at: end }],
        }),
      ).toThrow();
    },
  );

  test("Forward instants are valid even when their printed local order is reversed", () => {
    const period = {
      start: "2026-09-11T00:00:00+14:00",
      end: "2026-09-10T23:00:00-12:00",
      time_precision: "instant",
    };
    const result = normalize("measurement", {
      ...measurementFixture("cgm_summary"),
      effective_period: period,
    });
    expect(result.data.effective_period).toEqual(period);
    expect(result.time_precision).toBe("period");
    expect(result.occurred_at).toBeNull();
  });

  test.each([
    {
      start: "2026-09-02",
      end: "2026-09-01T01:00:00Z",
      time_precision: "unknown",
    },
    { start: "2026-09-01", end: "2026-09-02", time_precision: "instant" },
    {
      start: "2026-09-01T01:00:00Z",
      end: "2026-09-02T01:00:00Z",
      time_precision: "date",
    },
    { start: "2026-09-01", duration_seconds: 100, time_precision: "duration" },
    { time_precision: "duration" },
  ])("Period precision must match the known representation %#", (period) => {
    expect(() =>
      normalize("measurement", {
        ...measurementFixture("cgm_summary"),
        effective_period: period,
      }),
    ).toThrow();
  });

  test("Explicit unknown periods stay unknown in studies and actual fasting intervals", () => {
    const period = { time_precision: "unknown" };
    const study = normalize("measurement", {
      ...measurementFixture("cgm_summary"),
      effective_period: period,
    });
    expect(study.data.effective_period).toEqual(period);
    expect(study.occurred_at).toBeNull();
    const fasting = normalize("checkin", { actual_fasting_interval: period });
    expect(fasting.data.actual_fasting_interval).toEqual(period);
  });

  test("Mixed unknown endpoint precision is preserved without a midnight assumption", () => {
    for (const period of [
      {
        start: "2026-09-01",
        end: "2026-09-01T01:00:00+05:30",
        time_precision: "unknown",
      },
      {
        start: "2026-09-01T23:00:00+05:30",
        end: "2026-09-01",
        time_precision: "unknown",
      },
    ]) {
      const result = normalize("measurement", {
        ...measurementFixture("cgm_summary"),
        effective_period: period,
      });
      expect(result.data.effective_period).toEqual(period);
      expect(result.occurred_at).toBeNull();
      expect(result.ended_at).toBeNull();
    }
  });

  test("Lab common timestamps survive when the source has no separate date fields", () => {
    const data = { ...labFixture("hemoglobin"), collected_on: undefined };
    const result = normalizeInput(
      "lab_result",
      {
        provenance: base.provenance,
        timezone: "Asia/Kolkata",
        occurred_at: "2026-09-10T23:50:00-04:00",
        date_basis: "specimen_date",
        data,
      },
      "UTC",
      now,
    );
    expect(result.occurred_on).toBe("2026-09-11");
    expect(result.occurred_at).toBe("2026-09-11T03:50:00.000Z");
    expect(result.time_context.original_occurred_at).toBe(
      "2026-09-10T23:50:00-04:00",
    );
    expect(result.date_basis).toBe("specimen_date");
  });

  test.each(["specimen_date", "report_date"] as const)(
    "A supplied common instant is retained alongside its %s source calendar date",
    (dateBasis) => {
      const data = {
        ...labFixture("hemoglobin"),
        collected_on: dateBasis === "specimen_date" ? "2026-09-10" : undefined,
        reported_on: dateBasis === "report_date" ? "2026-09-10" : undefined,
      };
      const occurred_at = "2026-09-10T11:00:00+05:30";
      const result = normalize("lab_result", data, {
        occurred_at,
        date_basis: dateBasis,
      });
      expect(result.occurred_on).toBe("2026-09-10");
      expect(result.occurred_at).toBe("2026-09-10T05:30:00.000Z");
      expect(result.time_context.original_occurred_at).toBe(occurred_at);
      expect(result.date_basis).toBe(dateBasis);
      expect(result.data).toEqual(data);
      expect(() =>
        normalize("lab_result", data, {
          occurred_at: "2026-09-11T11:00:00+05:30",
          date_basis: dateBasis,
        }),
      ).toThrow();
    },
  );

  test("Timed collection instants are indexed without borrowing the report timestamp", () => {
    const period = {
      start: "2026-09-09T23:00:00+05:30",
      end: "2026-09-10T11:00:00+05:30",
      duration_seconds: 43200,
      time_precision: "instant",
      timezone: "Asia/Kolkata",
    };
    const result = normalizeInput(
      "lab_result",
      {
        provenance: base.provenance,
        timezone: "Asia/Kolkata",
        data: {
          ...labFixture("urine_protein_24h"),
          collected_on: undefined,
          collection_period: period,
          reported_at: "2026-09-11T12:00:00+05:30",
        },
      },
      "UTC",
      now,
    );
    expect(result.occurred_on).toBe("2026-09-09");
    expect(result.occurred_at).toBe("2026-09-09T17:30:00.000Z");
    expect(result.ended_at).toBe("2026-09-10T05:30:00.000Z");
    expect(result.data.collection_period).toEqual(period);
    expect(result.date_basis).toBe("specimen_date");
  });

  test("A date-only specimen date is retained independently of an overnight collection start", () => {
    const period = {
      start: "2026-09-09T23:00:00+05:30",
      end: "2026-09-10T11:00:00+05:30",
      time_precision: "instant",
      timezone: "Asia/Kolkata",
    };
    const result = normalize("lab_result", {
      ...labFixture("urine_protein_24h"),
      collection_period: period,
    });
    expect(result.occurred_on).toBe("2026-09-10");
    expect(result.occurred_at).toBeNull();
    expect(result.ended_at).toBe("2026-09-10T05:30:00.000Z");
    expect(result.data.collected_on).toBe("2026-09-10");
    expect(result.data.collection_period).toEqual(period);
    expect(result.time_precision).toBe("period");
    expect(result.date_basis).toBe("specimen_date");
  });

  test("A multi-night study date does not become an invented wake date", () => {
    const result = normalize("sleep", {
      entry_kind: "study_summary",
      session_type: "unknown",
      study_metadata: {
        study_type: "reported_other",
        effective_period: {
          start: "2026-09-01",
          end: "2026-09-07",
          time_precision: "date",
        },
      },
    });
    expect(result.date_basis).toBe("reported_date");
    expect(result.time_precision).toBe("period");
    expect(result.occurred_at).toBeNull();
  });

  test("Administration intervals preserve source endpoints and reject contradictory duplicates", () => {
    const period = {
      start: "2026-09-10T22:00:00+05:30",
      end: "2026-09-11T02:00:00+05:30",
      time_precision: "instant",
      duration_seconds: 14400,
    };
    const data = {
      product_name: "Synthetic administration",
      category: "medication",
      status: "taken",
      effective_period: period,
      duration_seconds: 14400,
    };
    const result = normalize("intake", data);
    expect(result.time_precision).toBe("period");
    expect(result.occurred_at).toBe("2026-09-10T16:30:00.000Z");
    expect(result.ended_at).toBe("2026-09-10T20:30:00.000Z");
    expect(result.data.effective_period).toEqual(period);
    expect(() =>
      normalize("intake", { ...data, start_at: "2026-09-10T23:00:00+05:30" }),
    ).toThrow();
    expect(() =>
      normalize("intake", { ...data, duration_seconds: 7200 }),
    ).toThrow();
  });
});

describe("Detailed source fields and contextual structural checks", () => {
  test("Glucose meal/challenge and composition hydration context are writable supplied metadata", () => {
    const data = {
      ...measurementFixture("blood_glucose"),
      meal_state: "post_meal",
      time_since_meal_minutes: 120,
      challenge_context: {
        label: "Source glucose challenge",
        dose: { kind: "quantity", value: 75, unit: "g" },
        elapsed_seconds: 7200,
      },
    };
    expect(normalize("measurement", data).data).toEqual(data);
    const body = {
      ...measurementFixture("total_body_water"),
      hydration_context: "Source-reported hydration state",
    };
    expect(normalize("measurement", body).data).toEqual(body);
  });

  test("Date-only lab lifecycle and site/clock metadata do not invent instants", () => {
    const data = {
      ...labFixture("hemoglobin"),
      received_on: "2026-09-10",
      analyzed_on: "2026-09-11",
      reported_on: "2026-09-12",
      laboratory_site: "Synthetic site",
      collection_clock_time: "08:15",
    };
    const result = normalize("lab_result", data);
    expect(result.data).toEqual(data);
    expect(result.occurred_at).toBeNull();
    expect(() =>
      normalize("lab_result", {
        ...data,
        analyzed_at: "2026-09-12T01:00:00+05:30",
      }),
    ).toThrow();
  });

  test.each([
    { administered_quantity: { kind: "quantity", value: -3, unit: "mg" } },
    { administered_quantity: { kind: "quantity", value: 3 } },
    {
      ingredients: [
        {
          compound_name: "Synthetic",
          compound_mass: { kind: "quantity", value: -10, unit: "mg" },
        },
      ],
    },
    {
      ingredients: [
        {
          compound_name: "Synthetic",
          strength: {
            numerator: { kind: "quantity", value: 1, unit: "mg" },
            denominator: { kind: "quantity", value: 0, unit: "tablet" },
            basis: "per_tablet",
          },
        },
      ],
    },
  ])(
    "Actual dose and formulation amounts keep physical quantity constraints %#",
    (fields) => {
      expect(() =>
        normalize("intake", {
          product_name: "Synthetic",
          category: "medication",
          status: "taken",
          ...fields,
        }),
      ).toThrow();
    },
  );

  test.each([
    { administered_volume_ml: 5 },
    { administration_rate: { kind: "quantity", value: 1, unit: "mL/h" } },
    {
      nutrient_contributions: { protein_g: null },
      nutrient_qualifiers: {
        protein_g: { kind: "interval", lower: 1, upper: 2, unit: "g" },
      },
    },
  ])(
    "Missed events cannot claim supplied administration or nutrient amounts %#",
    (fields) => {
      expect(() =>
        normalize("intake", {
          product_name: "Synthetic",
          category: "medication",
          status: "missed",
          ...fields,
        }),
      ).toThrow();
    },
  );

  test.each([
    { index: 1, type: "lap", cadence: 50 },
    { index: 1, type: "lap", energy_kcal: 50 },
    {
      index: 1,
      type: "lap",
      elapsed_seconds: 60,
      moving_seconds: 40,
      paused_seconds: 40,
    },
  ])(
    "Nested segments retain the same time, cadence and energy distinctions %#",
    (segment) => {
      expect(() =>
        normalize("activity", {
          ...examples.activity.data,
          segments: [segment],
        }),
      ).toThrow();
    },
  );

  test("Swimming counts require a declared lap/length meaning", () => {
    expect(() =>
      normalize("activity", {
        ...examples.activity.data,
        swimming: { count: 20 },
      }),
    ).toThrow();
    expect(
      normalize("activity", {
        ...examples.activity.data,
        swimming: { count: 20, count_meaning: "lengths" },
      }).data.swimming,
    ).toEqual({ count: 20, count_meaning: "lengths" });
  });

  test("Assistance preserves a supplied signed load without turning it into total load", () => {
    const set = {
      exercise_name: "Synthetic assisted movement",
      set_index: 1,
      repetitions: 8,
      load: { kind: "quantity", value: -15, unit: "kg" },
      load_interpretation: "assistance",
    };
    expect(
      normalize("activity", { ...examples.activity.data, strength: [set] }).data
        .strength,
    ).toEqual([set]);
    expect(() =>
      normalize("activity", {
        ...examples.activity.data,
        strength: [{ ...set, load_interpretation: "total" }],
      }),
    ).toThrow();
  });

  test("Independent comparator locations may agree but cannot contradict", () => {
    const data = {
      ...measurementFixture("weight"),
      value: { kind: "quantity", value: 50, unit: "kg" },
      comparator: "lt",
    };
    expect(normalize("measurement", data).data).toEqual(data);
    expect(() =>
      normalize("measurement", {
        ...data,
        value: { ...data.value, comparator: "gt" },
      }),
    ).toThrow();
  });

  test("Recovery pulse and a drop-from-peak use their declared units", () => {
    const data = measurementFixture("heart_rate_recovery");
    expect(() =>
      normalize("measurement", { ...data, unit: "bpm_drop" }),
    ).toThrow();
    expect(
      normalize("measurement", {
        ...data,
        unit: "bpm_drop",
        classification_metadata: {
          recovery_kind: "drop_from_peak",
          recovery_interval_seconds: 60,
        },
      }).data.unit,
    ).toBe("bpm_drop");
  });

  test("Paired pressure and pulse keep separate explicit units", () => {
    const data = {
      kind: "blood_pressure",
      unit: "mmHg",
      systolic: { kind: "quantity", value: 120, unit: "mmHg" },
      diastolic: { kind: "quantity", value: 80, unit: "mmHg" },
      pulse: {
        kind: "quantity",
        value: 60,
        unit: "bpm",
        original_unit: "/min",
      },
    };
    expect(measurementSchema(data)).toBe(true);
    expect(normalize("measurement", data).data).toEqual(data);
    for (const unit of ["bananas", "mmHg"]) {
      const invalid = { ...data, pulse: { ...data.pulse, unit } };
      expect(measurementSchema(invalid)).toBe(false);
      expect(() => normalize("measurement", invalid)).toThrow();
    }
    expect(() =>
      normalize("measurement", {
        ...data,
        systolic: { ...data.systolic, unit: "kPa" },
      }),
    ).toThrow();
  });

  test("A pending absence cannot also be a numeric result", () => {
    expect(() =>
      normalize("lab_result", {
        ...labFixture("blood_glucose"),
        data_absent_reason: "pending",
      }),
    ).toThrow();
    const data = {
      ...labFixture("blood_glucose"),
      result: { kind: "absent", reason: "pending" },
      data_absent_reason: "pending",
    };
    expect(normalize("lab_result", data).data).toEqual(data);
  });

  test("Other unquantified absence needs its supplied explanation", () => {
    const data = {
      entry_kind: "intake",
      nutrients: { protein_g: null },
      nutrient_qualifiers: {
        protein_g: { kind: "unquantified", reason: "other" },
      },
    };
    expect(() => normalize("nutrition", data)).toThrow();
    expect(
      normalize("nutrition", {
        ...data,
        nutrient_qualifiers: {
          protein_g: {
            ...data.nutrient_qualifiers.protein_g,
            explanation: "Source explanation",
          },
        },
      }).data.nutrients,
    ).toEqual({ protein_g: null });
  });
});
