import {
  labByKey,
  measurementByKey,
  studyKeys,
} from "../src/registry/definitions.js";
import type { Data, HealthRecord, RecordInput } from "../src/domain/types.js";
import { randomUUID } from "node:crypto";

export const fixtureDate = "2026-09-10";
export const base = {
  occurred_on: fixtureDate,
  timezone: "Asia/Kolkata",
  provenance: { source_type: "manual", value_kind: "reported" },
} as const;
export function measurementFixture(key: string): Data {
  const definition = measurementByKey.get(key)!;
  if (key === "blood_pressure")
    return {
      kind: "blood_pressure",
      systolic: 120,
      diastolic: 80,
      unit: "mmHg",
    };
  if (studyKeys.includes(key))
    return {
      kind: "study_summary",
      study_type: key,
      components: {},
      effective_period: {
        start: "2026-09-01",
        end: "2026-09-07",
        time_precision: "date",
      },
    };
  const value =
    key === "visual_acuity_snellen"
      ? {
          kind: "ratio",
          numerator: "6",
          denominator: "12",
          numerator_unit: "m",
          denominator_unit: "m",
        }
      : "1.25";
  return {
    kind: "scalar",
    metric_key: key,
    value,
    unit: definition.canonical_unit,
    ...Object.fromEntries(
      definition.required_context
        .filter((field) => ["body_region", "laterality"].includes(field))
        .map((field) => [field, field === "laterality" ? "left" : "arm"]),
    ),
    ...(key === "hearing_threshold"
      ? {
          laterality: "left",
          classification_metadata: { frequency_hz: 1000, conduction: "air" },
        }
      : {}),
    ...(key === "heart_rate_recovery"
      ? {
          classification_metadata: {
            recovery_kind: "actual_heart_rate",
            recovery_interval_seconds: 60,
          },
        }
      : {}),
  };
}
export function labFixture(key: string): Data {
  const variants = labByKey.get(key)!.result_variants;
  const kind = variants[0];
  const result =
    kind === "quantity"
      ? {
          kind,
          value: "1.250",
          unit: "source_unit",
          original_unit: "printed unit",
          original_value: "1.250",
        }
      : kind === "text"
        ? { kind, text: "Supplied pattern" }
        : kind === "coded"
          ? { kind, display: "Negative" }
          : kind === "titer"
            ? { kind, dilution_text: "1:160", numerator: 1, denominator: 160 }
            : kind === "pathogen_result"
              ? {
                  kind,
                  organism_or_target: "Supplied target",
                  result: { kind: "coded", display: "Not detected" },
                }
              : kind === "culture_result"
                ? {
                    kind,
                    growth: { kind: "coded", display: "Growth" },
                    isolates: [
                      { isolate_label: "A", organism: "Supplied organism" },
                    ],
                  }
                : {
                    kind: "susceptibility_result",
                    isolate_reference: "A",
                    antimicrobial: "Supplied antimicrobial",
                    mic: {
                      kind: "quantity",
                      value: "0.5",
                      comparator: "le",
                      unit: "ug/mL",
                    },
                    interpretation: "S",
                    breakpoint_standard: "Source standard",
                    breakpoint_version: "Supplied version",
                  };
  return {
    analyte_kind: "builtin",
    analyte_key: key,
    result,
    source_status: "final",
    collected_on: fixtureDate,
    specimen: { type: "unknown" },
  };
}
export function record(
  type: HealthRecord["record_type"],
  data: Data,
  override: Partial<HealthRecord> = {},
): HealthRecord {
  return {
    id: randomUUID(),
    record_type: type,
    schema_version: 2,
    version: 1,
    occurred_on: fixtureDate,
    occurred_at: null,
    ended_at: null,
    timezone: "Asia/Kolkata",
    time_precision: "date",
    date_basis: "reported_date",
    recorded_at: "2026-09-10T10:00:00.000Z",
    updated_at: "2026-09-10T10:00:00.000Z",
    status: "active",
    validity: "valid",
    provenance: base.provenance,
    data,
    time_context: {
      original_occurred_at: null,
      original_ended_at: null,
      supplied_timezone: "Asia/Kolkata",
    },
    ...override,
  };
}
export const examples: Record<HealthRecord["record_type"], RecordInput> = {
  measurement: { ...base, data: measurementFixture("weight") },
  nutrition: {
    ...base,
    data: {
      entry_kind: "intake",
      label: "Lunch",
      nutrients: {
        energy_kcal: 430,
        protein_g: 26,
        carbohydrate_g: 45,
        fat_g: 16,
        fiber_g: null,
      },
    },
  },
  hydration: {
    ...base,
    data: { entry_kind: "intake", volume_ml: 250, drink_type: "water" },
  },
  activity: {
    ...base,
    data: {
      entry_kind: "workout",
      activity_type: "treadmill_incline_walk",
      elapsed_seconds: 900,
      average_speed_mps: 1.2,
      treadmill_incline_percent: 5,
      energy_kcal: 80,
      energy_basis: "unknown",
    },
  },
  sleep: {
    ...base,
    data: { entry_kind: "session", session_type: "main", sleep_seconds: 24000 },
  },
  checkin: {
    ...base,
    data: {
      mood: "good",
      ratings: {
        energy: {
          value: 7,
          scale: "reported_energy",
          lower: 0,
          upper: 10,
          meaning: "Higher means more energy",
        },
      },
    },
  },
  intake: {
    ...base,
    data: {
      product_name: "Supplied supplement",
      category: "supplement",
      status: "taken",
      administered_quantity: { kind: "quantity", value: 1, unit: "tablet" },
    },
  },
  lab_result: { ...base, data: labFixture("hemoglobin") },
};
