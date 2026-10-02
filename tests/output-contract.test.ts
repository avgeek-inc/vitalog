import { describe, expect, test } from "vitest";
import { CATALOG_VERSION, recordTypes } from "../src/registry/definitions.js";
import { operationByName } from "../src/registry/operations.js";
import { examples, record } from "./fixtures.js";

const output = operationByName.get("health_get_record")!.output;

describe("stored record output contracts", () => {
  for (const type of recordTypes) {
    test(`${type} data matches its stored record type`, () => {
      const snapshot = record(type, examples[type].data);
      const response = { catalog_version: CATALOG_VERSION, record: snapshot };
      expect(output.safeParse(response).success).toBe(true);
      const otherType = type === "measurement" ? "nutrition" : "measurement";
      expect(
        output.safeParse({
          ...response,
          record: { ...snapshot, data: examples[otherType].data },
        }).success,
      ).toBe(false);
    });
  }

  test("version-one output preserves unknown legacy fields without current input validation", () => {
    const snapshot = record("nutrition", {
      legacy_source_fields: {
        carbohydrate: "unknown",
        source_label: "Original",
      },
    });
    snapshot.schema_version = 1;
    const response = { catalog_version: CATALOG_VERSION, record: snapshot };
    expect(output.parse(response)).toEqual(response);
  });
});
