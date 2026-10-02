import { z } from "zod";
import { describe, expect, test } from "vitest";
import { DomainError, parse } from "../src/errors.js";
import { recordInputs } from "../src/registry/records.js";
import { examples } from "./fixtures.js";

function failure(schema: z.ZodType, input: unknown): DomainError {
  try {
    parse(schema, input);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return error as DomainError;
  }
  throw new Error("Expected validation failure");
}

describe("actionable validation error paths", () => {
  test("Unknown root fields use an escaped JSON Pointer and schema discovery", () => {
    const error = failure(z.strictObject({}), { "source/name~": "inert" });
    expect(error.issues).toEqual([
      expect.objectContaining({
        path: "/source~1name~0",
        reason: "unknown_field",
        discovery: {
          tool: "health_get_catalog",
          arguments: { category: "record_schemas" },
          rest_path: "/v1/catalog?category=record_schemas",
        },
      }),
    ]);
  });
  test("Unknown nutrient names suggest exact writable keys", () => {
    const error = failure(recordInputs.nutrition, {
      ...examples.nutrition,
      data: { entry_kind: "intake", nutrients: { protein: 1 } },
    });
    expect(error.issues).toContainEqual(
      expect.objectContaining({
        path: "/data/nutrients/protein",
        suggested_keys: ["protein_g"],
      }),
    );
  });
  test("Nested analyte errors read the failed batch member for discovery", () => {
    const schema = z.strictObject({
      records: z.array(z.strictObject({ analyte_key: z.enum(["albumin"]) })),
    });
    const error = failure(schema, {
      records: [{ analyte_key: "albumin" }, { analyte_key: "hemoglobin" }],
    });
    expect(error.issues).toContainEqual(
      expect.objectContaining({
        path: "/records/1/analyte_key",
        reason: "unknown_builtin_analyte",
        discovery: expect.objectContaining({
          arguments: { category: "lab_analytes", key: "hemoglobin" },
        }),
      }),
    );
  });
});
