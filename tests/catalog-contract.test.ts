import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { afterAll, describe, expect, test } from "vitest";
import {
  catalog,
  catalogResponseBytes,
  fieldIndex,
  measurementDescriptor,
  recordDescriptor,
  MAX_RESPONSE_BYTES,
} from "../src/domain/catalog.js";
import { Cursors } from "../src/domain/cursor.js";
import { at, object, type Data } from "../src/domain/types.js";
import {
  CATALOG_VERSION,
  measurementDefinitions,
  labByKey,
  recognizedLabUnits,
  recordTypes,
} from "../src/registry/definitions.js";
import { catalogOutputSchema } from "../src/registry/catalog-output.js";
import { measurementFixture } from "./fixtures.js";
import { application } from "../src/app.js";
import { configuration } from "../src/config.js";
import { database } from "../src/db/client.js";
import { Service } from "../src/service.js";

const addFormats: FormatsPlugin = createRequire(import.meta.url)("ajv-formats");
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
const cursors = new Cursors("catalog-contract-test-only-cursor-key");
const credential = randomBytes(48).toString("base64url");
const config = configuration({
  AUTH_KEY: credential,
  DATABASE_URL: "postgresql://unused.invalid/catalog-contract-unit-test",
});
const connection = database(config.databaseUrl);
const service = new Service(connection.db, config.authDigest.toString("hex"));
const app = application(service, config, () => undefined);
const headers = {
  Authorization: `Bearer ${credential}`,
  Host: "localhost:3000",
};
afterAll(() => connection.pool.end());
async function restCatalog(input: Data): Promise<Data> {
  const query = new URLSearchParams(
    Object.entries(input).map(([key, value]) => [key, String(value)]),
  );
  const response = await app.request(
    `http://localhost:3000/v1/catalog?${query}`,
    {
      headers,
    },
  );
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(Buffer.byteLength(text)).toBeLessThan(MAX_RESPONSE_BYTES);
  return JSON.parse(text) as Data;
}
async function mcpCatalog(input: Data, id: number | string = 1): Promise<Data> {
  const response = await app.request("http://localhost:3000/mcp", {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "health_get_catalog", arguments: input },
    }),
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(Buffer.byteLength(text)).toBeLessThan(MAX_RESPONSE_BYTES);
  const result = object(object(JSON.parse(text)).result);
  expect(result.isError).toBeUndefined();
  const fallback = object((result.content as Data[])[0]).text;
  expect(JSON.parse(String(fallback))).toEqual(result.structuredContent);
  return object(result.structuredContent);
}
function referencesResolve(value: unknown, root: Data): void {
  if (Array.isArray(value)) {
    value.forEach((item) => referencesResolve(item, root));
    return;
  }
  if (!value || typeof value !== "object") return;
  const node = object(value);
  if (typeof node.$ref === "string") {
    expect(
      node.$ref.startsWith("#/"),
      "Schemas must use local references",
    ).toBe(true);
    const target = node.$ref
      .split("/")
      .slice(1)
      .reduce<unknown>(
        (item, key) =>
          object(item)[key.replaceAll("~1", "/").replaceAll("~0", "~")],
        root,
      );
    expect(target, `Unresolved ${node.$ref}`).toBeDefined();
  }
  Object.values(node).forEach((item) => referencesResolve(item, root));
}
function concretePath(template: string, index: Data[]): string {
  const parts = template.split("/");
  return parts
    .map((part, position) => {
      if (part === "{index}") return "0";
      if (part !== "{key}") return part;
      const parentTemplate = parts.slice(0, position + 1).join("/");
      const map = index.find((field) => field.field_path === parentTemplate)!;
      return (map.map_keys as string[])[0]!;
    })
    .join("/");
}
describe("Executable measurement discovery", () => {
  for (const definition of measurementDefinitions)
    test(`${definition.key} advertises its actual shape and bindings`, () => {
      const entry = measurementDescriptor(definition.key);
      const fixture = measurementFixture(definition.key);
      const schema = entry.writable_data_schema as Data;
      referencesResolve(schema, schema);
      const validate = ajv.compile(schema);
      expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
      expect(validate({ ...fixture, arbitrary_field: true })).toBe(false);
      if (definition.kind === "scalar") {
        expect(entry.field_path).toBe("/value");
        expect(validate({ ...fixture, metric_key: "unknown-metric" })).toBe(
          false,
        );
      } else {
        expect(entry.field_path).toBe("");
        expect(entry.value_field_paths).not.toContain("/value");
      }
      expect(Buffer.byteLength(JSON.stringify(entry))).toBeLessThan(
        MAX_RESPONSE_BYTES,
      );
      const definitions = entry.context_field_definitions as Data[];
      for (const context of definitions)
        referencesResolve(context.field_schema, object(context.field_schema));
      for (const binding of entry.field_bindings as Data[])
        referencesResolve(binding.field_schema, object(binding.field_schema));
    });
  test("Blood pressure stays paired and a study publishes its registered components", () => {
    const paired = measurementDescriptor("blood_pressure");
    expect(paired.result_variants).toEqual(["quantity"]);
    expect(paired.value_field_paths).toEqual([
      "/systolic",
      "/diastolic",
      "/pulse",
    ]);
    const study = measurementDescriptor("cgm_summary");
    expect(study.result_variants).toEqual([]);
    expect(study.component_keys).toEqual([
      "blood_glucose",
      "interstitial_glucose",
    ]);
    expect(study.value_field_paths).toEqual(["/components", "/cgm"]);
    const validate = ajv.compile(study.writable_data_schema as Data);
    const fixture = measurementFixture("cgm_summary");
    expect(
      validate({
        ...fixture,
        components: { weight: { value: 70, unit: "kg" } },
      }),
    ).toBe(false);
    expect(
      validate({ ...fixture, ambulatory_bp: { attempted_readings: 10 } }),
    ).toBe(false);
  });
});
describe("Complete concrete field discovery", () => {
  for (const type of recordTypes)
    test(`${type} resolves every indexed writable field with its descriptor`, () => {
      const index = fieldIndex(type);
      for (const field of index) {
        const path = concretePath(String(field.field_path), index);
        const response = catalog(
          { category: "record_schemas", key: type, field_path: path },
          cursors,
        );
        const entry = (response.items as Data[])[0]!;
        const descriptor = object(entry.descriptor);
        expect(descriptor.field_path).toBe(path);
        expect(descriptor.parent_path).toBe(
          path.split("/").slice(0, -1).join("/"),
        );
        expect(descriptor.path_template).toBe(field.field_path);
        expect(descriptor.record_type).toBe(type);
        expect(descriptor.required).toBeTypeOf("boolean");
        expect(Array.isArray(descriptor.required_conditions)).toBe(true);
        expect(Array.isArray(descriptor.applicable_conditions)).toBe(true);
        for (const name of ["applicable_conditions", "required_conditions"])
          for (const condition of descriptor[name] as Data[]) {
            expect(Array.isArray(condition.all_of)).toBe(true);
            expect(condition.condition_ref).toBeUndefined();
          }
        referencesResolve(entry.field_schema, object(entry.field_schema));
        expect(catalogOutputSchema.safeParse(response).success).toBe(true);
      }
    }, 30_000);
  test("Indexed strength requirements identify the actual item and variant", () => {
    const response = catalog(
      {
        category: "record_schemas",
        key: "activity",
        field_path: "/strength/0/load_interpretation",
      },
      cursors,
    );
    const descriptor = object((response.items as Data[])[0]!.descriptor);
    expect(descriptor.required).toBe(true);
    expect(descriptor.required_conditions).toContainEqual({
      all_of: [{ field_path: "/entry_kind", equals: "workout" }],
      parent_path: "/strength/0",
    });
    const qualifier = catalog(
      {
        category: "record_schemas",
        key: "nutrition",
        field_path: "/nutrient_qualifiers/protein_g/comparator",
      },
      cursors,
    );
    const qualifierDescriptor = object(
      (qualifier.items as Data[])[0]!.descriptor,
    );
    expect(qualifierDescriptor.required_conditions).toContainEqual({
      all_of: [
        { field_path: "/nutrient_qualifiers/protein_g/kind", equals: "bound" },
      ],
      parent_path: "/nutrient_qualifiers/protein_g",
    });
  });
  test("Concrete component requirements exclude unrelated registered keys", () => {
    const lookup = (key: string) =>
      object(
        (
          catalog(
            {
              category: "record_schemas",
              key: "measurement",
              field_path: `/components/${key}/context/body_region`,
            },
            cursors,
          ).items as Data[]
        )[0]!.descriptor,
      );
    expect(lookup("segmental_lean_mass").required).toBe(true);
    const glucose = lookup("blood_glucose");
    expect(glucose.required).toBe(false);
    expect(glucose.required_when_parent_present).toBe(false);
    expect(glucose.required_conditions).toEqual([]);
  });
  test("Unit requirements describe alternative locations and nonnumeric results", () => {
    const descriptor = (type: string, field_path: string) =>
      object(
        (
          catalog(
            { category: "record_schemas", key: type, field_path },
            cursors,
          ).items as Data[]
        )[0]!.descriptor,
      );
    const outer = descriptor("measurement", "/unit");
    const conditions = outer.required_conditions as Data[];
    expect(conditions).toContainEqual({
      all_of: [{ field_path: "/kind", equals: "blood_pressure" }],
      parent_path: "",
    });
    const scalar = conditions.find((condition) =>
      (condition.all_of as Data[]).some((rule) => rule.equals === "scalar"),
    )!;
    expect(scalar.all_of).toContainEqual({
      field_path: "/value",
      requires_enclosing_unit: true,
    });
    for (const field of [
      descriptor("measurement", "/value/unit"),
      descriptor("lab_result", "/result/mic/unit"),
    ]) {
      for (const condition of field.required_conditions as Data[]) {
        expect(condition.all_of).toContainEqual({
          field_path: "/unit",
          missing: true,
        });
        expect(condition.all_of).toContainEqual({
          field_path: `${String(field.parent_path)}/kind`,
          one_of: ["quantity", "interval"],
        });
      }
      expect(field.condition_semantics).toMatchObject({
        requires_enclosing_unit: expect.any(String),
      });
    }
    const segmental = descriptor(
      "measurement",
      "/components/segmental_lean_mass/context/body_region",
    );
    for (const condition of segmental.required_conditions as Data[])
      expect(condition.all_of).toContainEqual({
        field_path: "/components/segmental_lean_mass/value/kind",
        not_equals: "absent",
      });
  });
});
describe("Typed catalog response contracts", () => {
  test("Recognized lab-unit hints name registered analytes", () => {
    for (const key of Object.keys(recognizedLabUnits))
      expect(labByKey.has(key), `Unknown analyte policy ${key}`).toBe(true);
    expect(labByKey.get("blood_glucose")!.recognized_units).toEqual([
      "mg/dL",
      "mmol/L",
    ]);
  });
  test("Full schema field indexes resolve all condition references locally", () => {
    for (const type of recordTypes) {
      const descriptor = recordDescriptor(type, true);
      const sourceFields = fieldIndex(type);
      for (const [position, field] of (
        descriptor.field_index as Data[]
      ).entries())
        for (const name of ["applicable_conditions", "required_conditions"])
          for (const [index, condition] of (field[name] as Data[]).entries()) {
            expect(String(condition.condition_ref)).toMatch(
              /^#\/condition_definitions\/condition_\d+$/,
            );
            const rules = at(
              descriptor,
              String(condition.condition_ref).slice(1),
            );
            expect(rules).toEqual(
              (sourceFields[position]![name] as Data[])[index]!.all_of,
            );
          }
    }
  });
  test("Each category and full schema lookup matches the typed output contract", () => {
    for (const category of [
      "overview",
      "nutrients",
      "lab_panels",
      "lab_analytes",
      "measurements",
      "record_schemas",
    ]) {
      const response = catalog({ category }, cursors);
      const result = catalogOutputSchema.safeParse(response);
      expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
      expect(response.catalog_version).toBe(CATALOG_VERSION);
    }
    for (const type of recordTypes) {
      const response = catalog(
        { category: "record_schemas", key: type, include_schema: true },
        cursors,
      );
      const result = catalogOutputSchema.safeParse(response);
      expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
      const entry = recordDescriptor(type, true);
      referencesResolve(
        entry.writable_data_schema,
        object(entry.writable_data_schema),
      );
    }
  }, 30_000);
  test("Output schemas reject opaque items and incorrect envelopes", () => {
    const response = catalog(
      { category: "measurements", key: "weight" },
      cursors,
    );
    expect(
      catalogOutputSchema.safeParse({
        ...response,
        items: [{ anything: true }],
      }).success,
    ).toBe(false);
    expect(
      catalogOutputSchema.safeParse({ ...response, category: "lab_analytes" })
        .success,
    ).toBe(false);
    const { next_cursor: _cursor, ...missing } = response;
    expect(catalogOutputSchema.safeParse(missing).success).toBe(false);
    expect(
      catalogOutputSchema.safeParse({ ...response, unsupported_field: true })
        .success,
    ).toBe(false);
  });
});
describe("Catalog wire bounds and transport parity", () => {
  test.each([
    { category: "record_schemas" },
    { category: "record_schemas", key: "measurement", include_schema: true },
  ])(
    "%j succeeds over REST and MCP within the response cap",
    async (input) => {
      const rest = await restCatalog(input);
      const mcp = await mcpCatalog(input);
      expect(mcp).toEqual(rest);
      expect(catalogResponseBytes(mcp)).toBeLessThan(MAX_RESPONSE_BYTES);
    },
    30_000,
  );
  test("Every measurement remains discoverable through identical bounded pages", async () => {
    const keys: string[] = [];
    let cursor: unknown;
    do {
      const input = { category: "measurements", ...(cursor ? { cursor } : {}) };
      const rest = await restCatalog(input);
      const mcp = await mcpCatalog(input);
      expect(mcp).toEqual(rest);
      expect(rest.returned_count).toBeGreaterThan(0);
      keys.push(...(rest.items as Data[]).map((entry) => String(entry.key)));
      cursor = rest.next_cursor;
      expect(rest.has_more).toBe(Boolean(cursor));
    } while (cursor);
    expect(keys.length).toBe(measurementDefinitions.length);
    expect(new Set(keys).size).toBe(measurementDefinitions.length);
  }, 30_000);
  test("Paging reserves the bounded JSON-RPC request id on the wire", async () => {
    const response = await mcpCatalog(
      { category: "measurements" },
      "x".repeat(1024 * 1024 - 1000),
    );
    expect(response.returned_count).toBeGreaterThan(0);
    expect(response.has_more).toBe(true);
  }, 30_000);
});
