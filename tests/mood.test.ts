import { expect, test } from "vitest";
import { fieldIndex } from "../src/domain/catalog.js";
import { dailySummary } from "../src/domain/summary.js";
import { normalizeInput } from "../src/domain/validation.js";
import { object, type Data, type HealthRecord } from "../src/domain/types.js";
import { moodValues } from "../src/registry/definitions.js";
import { discoverySchema } from "../src/mcp-schema.js";
import { operations } from "../src/registry/operations.js";
import { recordSchemas } from "../src/registry/records.js";
import { base, fixtureDate, record } from "./fixtures.js";

const log = operations.find(
  (operation) => operation.name === "health_log_checkin",
)!;
const summary = operations.find(
  (operation) => operation.name === "health_get_daily_summary",
)!;
const now = new Date("2026-10-05T12:00:00Z");
const day = (records: HealthRecord[]) => {
  const result = dailySummary(records, fixtureDate, "Asia/Kolkata");
  summary.output.parse(result);
  return object(result.checkin);
};
const checkin = (data: Data, properties: Partial<HealthRecord> = {}) =>
  record("checkin", data, properties);

for (const mood of moodValues)
  test(`Mood ${mood} accepts a minimal check-in through the shared write schema`, () => {
    const input = { ...base, data: { mood } };
    expect(
      log.input.parse({ ...input, idempotency_key: "mood-checkin" }).data,
    ).toEqual({ mood });
    expect(normalizeInput("checkin", input, "Asia/Kolkata", now).data).toEqual({
      mood,
    });
  });

for (const mood of ["happy", "GOOD", "", 3, null, { value: "good" }])
  test(`Undeclared mood ${JSON.stringify(mood)} is rejected`, () => {
    expect(recordSchemas.checkin.safeParse({ mood }).success).toBe(false);
    expect(() =>
      normalizeInput(
        "checkin",
        { ...base, data: { mood } },
        "Asia/Kolkata",
        now,
      ),
    ).toThrow();
  });

test("Catalog fields and MCP discovery declare the same mood enum", () => {
  const field = fieldIndex("checkin").find(
    (item) => item.field_path === "/mood",
  );
  expect(field).toBeDefined();
  expect(JSON.stringify(field)).toContain(JSON.stringify(moodValues));
  const discovery = discoverySchema(log.input);
  expect(
    object(object(object(object(discovery).properties).data).properties).mood,
  ).toMatchObject({
    type: "string",
    enum: [...moodValues],
  });
});

test("Latest mood uses observation instants across offsets, independent of insertion order", () => {
  const older = checkin(
    { mood: "low" },
    {
      occurred_at: "2026-09-10T14:00:00+05:30",
      recorded_at: "2026-09-10T20:00:00Z",
    },
  );
  const newer = checkin(
    { mood: "good", notes: "After a walk" },
    {
      occurred_at: "2026-09-10T10:00:00Z",
      recorded_at: "2026-09-10T10:01:00Z",
    },
  );
  for (const records of [
    [older, newer],
    [newer, older],
  ]) {
    expect(day(records).latest_mood).toEqual({
      value: "good",
      source_id: newer.id,
      occurred_at: newer.occurred_at,
      recorded_at: newer.recorded_at,
    });
    expect(day(records).observations).toHaveLength(2);
  }
});

test("Mood selection excludes voids, other days, invalid records and invalid mood fields", () => {
  const valid = checkin({ mood: "neutral" });
  const excluded = [
    checkin({ mood: "great" }, { status: "voided" }),
    checkin({ mood: "great" }, { validity: "invalid" }),
    checkin({ mood: "great" }, { occurred_on: "2026-09-11" }),
    checkin(
      { mood: "great" },
      {
        provenance: {
          ...base.provenance,
          field_overrides: { "/mood": { validity: "invalid" } },
        },
      },
    ),
    checkin({ mood: "unrecognised_legacy_value" }, { schema_version: 1 }),
  ];
  expect(object(day([valid, ...excluded]).latest_mood).source_id).toBe(
    valid.id,
  );
  expect(day(excluded).latest_mood).toBeNull();
});

test("Missing mood stays unknown and existing numeric mood scores remain independent", () => {
  const rated = checkin({
    ratings: { mood: { value: 4, scale: "supplied_0_5", lower: 0, upper: 5 } },
  });
  expect(
    normalizeInput(
      "checkin",
      { ...base, data: rated.data },
      "Asia/Kolkata",
      now,
    ).data,
  ).toEqual(rated.data);
  expect(day([rated]).latest_mood).toBeNull();
  expect(day([]).latest_mood).toBeNull();
  expect(day([rated]).observations).toEqual([rated]);
});

test("Date-only check-ins fall back to recording time and ties are deterministic", () => {
  const older = checkin(
    { mood: "low" },
    { recorded_at: "2026-09-10T10:00:00Z" },
  );
  const newer = checkin(
    { mood: "good" },
    { recorded_at: "2026-09-10T11:00:00Z" },
  );
  expect(object(day([newer, older]).latest_mood).source_id).toBe(newer.id);
  const tied = checkin(
    { mood: "great" },
    {
      recorded_at: newer.recorded_at,
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    },
  );
  for (const records of [
    [tied, newer],
    [newer, tied],
  ])
    expect(object(day(records).latest_mood).source_id).toBe(tied.id);
});

test("A check-in section filter includes mood; unrelated section filters omit it", () => {
  const records = [checkin({ mood: "good" })];
  expect(
    object(
      dailySummary(records, fixtureDate, "Asia/Kolkata", ["checkin"]).checkin,
    ).latest_mood,
  ).not.toBeNull();
  expect(
    dailySummary(records, fixtureDate, "Asia/Kolkata", ["nutrition"]).checkin,
  ).toBeUndefined();
});
