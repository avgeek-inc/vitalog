import { describe, expect, test } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createRequire } from "node:module";
import type { FormatsPlugin } from "ajv-formats";
import { randomBytes } from "node:crypto";
import { configuration, authorized } from "../src/config.js";
import {
  boundedResponse,
  catalog,
  fieldIndex,
  recordDescriptor,
  MAX_RESPONSE_BYTES,
} from "../src/domain/catalog.js";
import { Cursors } from "../src/domain/cursor.js";
import { normalizeInput, upgradeSnapshot } from "../src/domain/validation.js";
import {
  inventory,
  nutrientKeys,
  analyteKeys,
  measurementKeys,
  recordTypes,
  CATALOG_VERSION,
} from "../src/registry/definitions.js";
import { jsonSchema } from "../src/registry/primitives.js";
import { operations } from "../src/registry/operations.js";
import { recordSchemas } from "../src/registry/records.js";
import { base, examples, labFixture, measurementFixture } from "./fixtures.js";
import { openapi } from "../src/openapi.js";

const addFormats: FormatsPlugin = createRequire(import.meta.url)("ajv-formats");
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
const now = new Date("2026-10-02T12:00:00Z");
const cursors = new Cursors("test-cursor-signing-material");
describe("Inventory and schema parity", () => {
  test("Exact required counts and panel identity", () => {
    expect(new Set(nutrientKeys).size).toBe(182);
    expect(new Set(analyteKeys).size).toBe(424);
    expect(new Set(measurementKeys).size).toBe(110);
    expect(inventory.lab_panels).toHaveLength(30);
    expect(operations).toHaveLength(16);
    expect(recordTypes).toHaveLength(8);
    expect(
      new Set(inventory.lab_panels.flatMap((panel) => panel.analyte_keys)),
    ).toEqual(new Set(analyteKeys));
  });
  for (const type of recordTypes)
    test(`Complete self-contained ${type} schema, logging and nested field discovery`, () => {
      const validate = ajv.compile(jsonSchema(recordSchemas[type]));
      expect(
        validate(examples[type].data),
        JSON.stringify(validate.errors),
      ).toBe(true);
      const descriptor = recordDescriptor(type, true);
      expect(JSON.stringify(descriptor).length).toBeLessThan(
        MAX_RESPONSE_BYTES,
      );
      expect(fieldIndex(type).length).toBeGreaterThan(5);
      const operation = operations.find((op) => op.record_type === type)!;
      const args = operation.batch
        ? { idempotency_key: "test", records: [examples[type]] }
        : { idempotency_key: "test", ...examples[type] };
      const inputValidate = ajv.compile(jsonSchema(operation.input));
      expect(inputValidate(args), JSON.stringify(inputValidate.errors)).toBe(
        true,
      );
      normalizeInput(type, examples[type], "Asia/Kolkata", now);
    });
  for (const key of nutrientKeys)
    test(`Nutrient ${key} accepts exact zero and unknown, rejects unadvertised fields`, () => {
      normalizeInput(
        "nutrition",
        { ...base, data: { entry_kind: "intake", nutrients: { [key]: 0 } } },
        "Asia/Kolkata",
        now,
      );
      normalizeInput(
        "nutrition",
        { ...base, data: { entry_kind: "intake", nutrients: { [key]: null } } },
        "Asia/Kolkata",
        now,
      );
    });
  for (const key of measurementKeys)
    test(`Measurement ${key} has a usable typed write definition`, () => {
      normalizeInput(
        "measurement",
        { ...base, data: measurementFixture(key) },
        "Asia/Kolkata",
        now,
      );
    });
  for (const key of analyteKeys)
    test(`Lab ${key} has a usable typed write definition`, () => {
      const fixture = labFixture(key);
      normalizeInput(
        "lab_result",
        { ...base, data: fixture },
        "Asia/Kolkata",
        now,
      );
      const entry = (
        catalog({ category: "lab_analytes", key }, cursors).items as {
          field_schema: object;
        }[]
      )[0]!;
      const validate = ajv.compile(entry.field_schema);
      expect(validate(fixture.result), JSON.stringify(validate.errors)).toBe(
        true,
      );
    });
});
describe("Catalog invariants", () => {
  test("Every category paginates exactly once; all panel members are complete", () => {
    for (const [category, count] of [
      ["nutrients", 182],
      ["lab_analytes", 424],
      ["measurements", 110],
      ["lab_panels", 30],
    ] as const) {
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const page = catalog(
          { category, limit: 17, ...(cursor ? { cursor } : {}) },
          cursors,
        );
        keys.push(
          ...(page.items as { key: string }[]).map((entry) => entry.key),
        );
        cursor = page.next_cursor as string | undefined;
      } while (cursor);
      expect(keys).toHaveLength(count);
      expect(new Set(keys).size).toBe(count);
    }
    for (const panel of inventory.lab_panels)
      expect(
        (
          catalog(
            {
              category: "lab_analytes",
              panel_key: panel.panel_key,
              limit: 100,
            },
            cursors,
          ).items as { key: string }[]
        )
          .map((entry) => entry.key)
          .sort(),
      ).toEqual([...panel.analyte_keys].sort());
  });
  test("Exact lookups and literal searches", () => {
    expect(() =>
      catalog({ category: "nutrients", key: "carbs" }, cursors),
    ).toThrow();
    expect(
      catalog({ category: "lab_analytes", query: "haemoglobin" }, cursors)
        .returned_count,
    ).toBe(1);
    expect(
      catalog({ category: "lab_analytes", query: ".*;DROP TABLE" }, cursors)
        .returned_count,
    ).toBe(0);
    expect(() =>
      catalog(
        { category: "nutrients", group_key: "amino_acids", key: "energy_kcal" },
        cursors,
      ),
    ).toThrow();
  });
  test("Filter combinations fail explicitly", () => {
    for (const query of [
      { limit: 10 },
      { category: "nutrients", panel_key: "cbc" },
      { category: "lab_analytes", group_key: "fatty_acids" },
      { category: "record_schemas", include_schema: true },
      { category: "nutrients", key: "protein_g", limit: 1 },
      {
        category: "record_schemas",
        key: "sleep",
        include_schema: true,
        field_path: "/respiratory_events",
      },
    ])
      expect(() => catalog(query, cursors)).toThrow();
  });
  test("Nested complete field lookups and invalid pointers", () => {
    for (const [key, path] of [
      ["sleep", "/respiratory_events"],
      ["activity", "/strength/0/load_interpretation"],
      ["lab_result", "/reference_ranges/0"],
      ["nutrition", "/nutrient_qualifiers/protein_g"],
      ["intake", "/ingredients/0/strength/denominator"],
    ]) {
      const result = catalog(
        { category: "record_schemas", key, field_path: path },
        cursors,
      );
      const schema = (result.items as { field_schema: object }[])[0]!
        .field_schema;
      ajv.compile(schema);
    }
    expect(() =>
      catalog(
        { category: "record_schemas", key: "sleep", field_path: "/target" },
        cursors,
      ),
    ).toThrow();
  });
  test("Cursors bind filters, limit and catalog version", () => {
    const page = catalog({ category: "nutrients", limit: 2 }, cursors);
    expect(() =>
      catalog(
        { category: "nutrients", limit: 3, cursor: page.next_cursor },
        cursors,
      ),
    ).toThrow();
    expect(() =>
      catalog({ category: "nutrients", catalog_version: "0.9.0" }, cursors),
    ).toThrow(/current catalog/);
    expect(() =>
      catalog({ category: "nutrients", cursor: "invalid" }, cursors),
    ).toThrow();
  });
  test("Generated interfaces have no private values or extra product surface", () => {
    const doc = openapi();
    const text = JSON.stringify(doc);
    expect(text).not.toContain("example-nutrition-event-001");
    for (const term of [
      "/oauth",
      "/goals",
      "/users",
      "/uploads",
      "/recipes",
      "/catalog/metrics",
    ])
      expect(text).not.toContain(term);
    expect(Object.keys(doc.paths as object)).toHaveLength(19);
    expect(catalog({}, cursors).catalog_version).toBe(CATALOG_VERSION);
  });
  test("Oversized responses fail without truncating the requested value", () => {
    expect(() =>
      boundedResponse({ supplied: "x".repeat(MAX_RESPONSE_BYTES) }),
    ).toThrow(/byte limit/);
  });
});
describe("Authentication and input semantics", () => {
  test("Missing and placeholder keys fail startup; fixed digest authentication is strict", () => {
    const key = randomBytes(32).toString("base64url");
    const config = configuration({
      AUTH_KEY: key,
      DATABASE_URL: "postgresql://unused",
    });
    expect(authorized(`Bearer ${key}`, config)).toBe(true);
    for (const header of [
      undefined,
      key,
      `Bearer  ${key}`,
      `bearer ${key}`,
      `Bearer ${key}, Bearer ${key}`,
      `Bearer ${key} `,
    ])
      expect(authorized(header, config)).toBe(false);
    for (const key of [
      undefined,
      "",
      "replace-with-an-operator-supplied-secret",
      "x".repeat(32),
    ])
      expect(() =>
        configuration({ AUTH_KEY: key, DATABASE_URL: "postgresql://unused" }),
      ).toThrow();
    expect(() =>
      configuration({
        AUTH_KEY: key,
        DATABASE_URL: "postgresql://unused",
        TRUST_PROXY: "true",
      }),
    ).toThrow();
  });
  test("Date-only values stay date-only and precise local boundaries are checked", () => {
    const dateOnly = normalizeInput(
      "measurement",
      examples.measurement,
      "UTC",
      now,
    );
    expect(dateOnly.occurred_at).toBeNull();
    expect(dateOnly.timezone).toBe("Asia/Kolkata");
    const input = {
      ...examples.measurement,
      occurred_on: "2026-09-11",
      occurred_at: "2026-09-10T23:30:00Z",
    };
    expect(normalizeInput("measurement", input, "UTC", now).occurred_on).toBe(
      "2026-09-11",
    );
    expect(() =>
      normalizeInput(
        "measurement",
        { ...input, occurred_on: "2026-09-10" },
        "UTC",
        now,
      ),
    ).toThrow();
    expect(() =>
      normalizeInput(
        "measurement",
        { ...examples.measurement, occurred_on: "2026-02-30" },
        "UTC",
        now,
      ),
    ).toThrow();
    expect(() =>
      normalizeInput(
        "measurement",
        { ...examples.measurement, occurred_on: "2027-01-01" },
        "UTC",
        now,
      ),
    ).toThrow();
    const original = "2026-09-10T23:30:00+05:30";
    const precise = normalizeInput(
      "measurement",
      { ...examples.measurement, occurred_at: original },
      "UTC",
      now,
    );
    expect(precise.occurred_at).toBe("2026-09-10T18:00:00.000Z");
    expect(precise.time_context.original_occurred_at).toBe(original);
  });
  test("Sleep uses its wake date and retains stages, studies and PAP metadata", () => {
    const data = {
      entry_kind: "session",
      session_type: "main",
      start_at: "2026-09-09T22:00:00+05:30",
      end_at: "2026-09-10T06:00:00+05:30",
      sleep_seconds: 25000,
      stage_system: "device_light_deep",
      stage_durations: { light: 20000, deep: 5000 },
      respiratory_events: { ahi: { value: 1.2, denominator: "sleep_hours" } },
      pap_session: {
        leak: { value: 5, unit: "L/min", basis: "percentile", percentile: 95 },
      },
    };
    expect(
      normalizeInput("sleep", { ...base, data }, "UTC", now).date_basis,
    ).toBe("wake_date");
    expect(() =>
      normalizeInput(
        "sleep",
        { ...base, occurred_on: "2026-09-09", data },
        "UTC",
        now,
      ),
    ).toThrow();
  });
  test("Unknown and qualified nutrient values cannot be coerced", () => {
    normalizeInput(
      "nutrition",
      {
        ...base,
        data: {
          entry_kind: "intake",
          nutrients: { added_sugars_g: 0.5, fiber_g: null },
          nutrient_qualifiers: {
            added_sugars_g: { kind: "bound", comparator: "lt" },
          },
        },
      },
      "UTC",
      now,
    );
    for (const data of [
      { entry_kind: "intake", nutrients: { protein: 1 } },
      { entry_kind: "intake", nutrients: { protein_g: -1 } },
      {
        entry_kind: "intake",
        nutrients: { protein_g: 1 },
        quantity_basis: "per_100_g",
      },
      {
        entry_kind: "intake",
        nutrients: { protein_g: 1 },
        nutrient_qualifiers: {
          protein_g: { kind: "interval", lower: 1, upper: 2, unit: "g" },
        },
      },
    ])
      expect(() =>
        normalizeInput("nutrition", { ...base, data }, "UTC", now),
      ).toThrow();
  });
  test("Signed values, original ranges and unknown lab units round-trip", () => {
    for (const key of [
      "bone_density_z_score",
      "p_axis",
      "skin_temperature_deviation",
    ])
      expect(
        normalizeInput(
          "measurement",
          { ...base, data: { ...measurementFixture(key), value: "-1.500" } },
          "UTC",
          now,
        ).data.value,
      ).toBe("-1.500");
    const lab = {
      ...labFixture("base_excess"),
      result: { kind: "quantity", value: "-8.50", unit: "unfamiliar-unit" },
      reference_ranges: [
        { lower: 0, upper: 1, method: "A" },
        { lower: 2, upper: 3, method: "B", pregnancy_context: "supplied" },
      ],
    };
    expect(
      normalizeInput("lab_result", { ...base, data: lab }, "UTC", now).data,
    ).toEqual(lab);
  });
  test("Typed absence, negative coded, titer, interval and ratios remain distinct", () => {
    const results = [
      { kind: "quantity", value: 0, unit: "1" },
      { kind: "coded", display: "Negative" },
      { kind: "absent", reason: "pending" },
      { kind: "absent", reason: "below_detection_unquantified" },
      { kind: "interval", lower: 1, upper: 2, unit: "1" },
      { kind: "quantity", value: 0.5, comparator: "lt", unit: "1" },
      { kind: "titer", dilution_text: "1:160" },
    ];
    for (const result of results)
      expect(
        normalizeInput(
          "lab_result",
          {
            provenance: base.provenance,
            data: {
              analyte_kind: "custom",
              analyte_key: null,
              original_analyte_name: "Supplied",
              result,
            },
          },
          "UTC",
          now,
        ).data.result,
      ).toEqual(result);
    expect(() =>
      normalizeInput(
        "lab_result",
        {
          ...base,
          data: {
            analyte_kind: "custom",
            analyte_key: null,
            original_analyte_name: "Supplied",
            result: { kind: "ratio", numerator: 1, denominator: 0 },
          },
        },
        "UTC",
        now,
      ),
    ).toThrow();
  });
  test("Original specimen/report dates and undated labs are preserved", () => {
    expect(
      normalizeInput(
        "lab_result",
        {
          provenance: base.provenance,
          data: {
            ...labFixture("hemoglobin"),
            collected_on: undefined,
            reported_on: "2026-09-11",
          },
        },
        "UTC",
        now,
      ).date_basis,
    ).toBe("report_date");
    const unknown = normalizeInput(
      "lab_result",
      {
        provenance: base.provenance,
        data: {
          ...labFixture("hemoglobin"),
          collected_on: undefined,
          original_date_notes: "Unreadable date",
        },
      },
      "UTC",
      now,
    );
    expect(unknown.occurred_on).toBeNull();
    expect(unknown.occurred_at).toBeNull();
    expect(unknown.date_basis).toBe("unknown");
  });
  test("Field-level validity requires an existing indexed path", () => {
    const input = {
      ...examples.activity,
      data: { ...examples.activity.data, average_heart_rate_bpm: 100 },
      provenance: {
        ...base.provenance,
        field_overrides: {
          "/average_heart_rate_bpm": {
            validity: "invalid",
            reason: "No hand sensors",
          },
        },
      },
    };
    normalizeInput("activity", input, "UTC", now);
    expect(() =>
      normalizeInput(
        "activity",
        {
          ...input,
          provenance: {
            ...input.provenance,
            field_overrides: { "/target": { validity: "invalid" } },
          },
        },
        "UTC",
        now,
      ),
    ).toThrow();
  });
  test("Version-one snapshots migrate without reinterpretation", () => {
    const snapshot = {
      nutrients: { carbohydrate_g: 20, folate_ug: 100, vitamin_k_ug: 10 },
    };
    expect(upgradeSnapshot(snapshot, 1).snapshot).toEqual(snapshot);
    expect(snapshot).not.toHaveProperty("component_details");
  });
});
