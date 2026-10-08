import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { database } from "../src/db/client.js";
import { healthRecords, revisions } from "../src/db/schema.js";
import { localDate, normalizeInput } from "../src/domain/validation.js";
import {
  object,
  type Data,
  type HealthRecord,
  type RecordInput,
} from "../src/domain/types.js";
import { operationByName } from "../src/registry/operations.js";
import { nutrientKeys } from "../src/registry/definitions.js";
import { Service } from "../src/service.js";
import { base, fixtureDate, record } from "../tests/fixtures.js";
import { migrateDatabase } from "./migrate.js";

const container = `vitalog-summary-verification-${process.pid}`;
const password = randomBytes(32).toString("hex");
const checks: { name: string; status: "passed"; assertions: number }[] = [];
const command = (args: string[], env = process.env) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    env,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 4 * 1024 * 1024,
  }).trim();
let connection: ReturnType<typeof database> | undefined;
let service: Service;
async function check(name: string, fn: () => Promise<number>) {
  process.stdout.write(`RUN ${name}\n`);
  checks.push({ name, status: "passed", assertions: await fn() });
  process.stdout.write(`PASS ${name}\n`);
}
function saved(
  type: HealthRecord["record_type"],
  data: Data,
  input: Partial<RecordInput> = {},
): HealthRecord {
  const { warnings: _warnings, ...normalized } = normalizeInput(
    type,
    { ...base, ...input, data },
    "Asia/Kolkata",
  );
  return record(type, normalized.data, normalized);
}
async function insert(records: HealthRecord[]) {
  for (let offset = 0; offset < records.length; offset += 100)
    await connection!.db.insert(healthRecords).values(
      records.slice(offset, offset + 100).map((entry) => ({
        id: entry.id,
        recordType: entry.record_type,
        schemaVersion: entry.schema_version,
        version: entry.version,
        occurredOn: entry.occurred_on,
        occurredAt: entry.occurred_at,
        endedAt: entry.ended_at,
        timezone: entry.timezone,
        timePrecision: entry.time_precision,
        dateBasis: entry.date_basis,
        recordedAt: entry.recorded_at,
        updatedAt: entry.updated_at,
        status: entry.status,
        validity: entry.validity,
        provenance: entry.provenance,
        payload: entry.data,
        timeContext: entry.time_context,
      })),
    );
}
async function reset() {
  await connection!.db.execute(
    sql`truncate record_attachments, health_records, record_revisions, idempotency_requests`,
  );
}
async function read(name: string, input: Data): Promise<Data> {
  const result = await service.execute(name, input);
  const schema = operationByName.get(name)!.output;
  const parsed = schema.safeParse(result);
  assert(parsed.success, JSON.stringify(parsed.error?.issues));
  return result;
}
function cgms(count: number, start: string, end: string) {
  return Array.from({ length: count }, () =>
    saved(
      "measurement",
      {
        kind: "study_summary",
        study_type: "cgm_summary",
        components: {},
        effective_period: { start, end, time_precision: "date" },
        cgm: { mean_glucose: { kind: "quantity", value: 100, unit: "mg/dL" } },
      },
      { occurred_on: end },
    ),
  );
}
async function countRecords(): Promise<number> {
  const result = await connection!.db.execute<{ count: string }>(
    sql`select count(*)::text as count from health_records`,
  );
  return Number(result.rows[0]!.count);
}
try {
  command(
    [
      "run",
      "--detach",
      "--rm",
      "--name",
      container,
      "-e",
      "POSTGRES_PASSWORD",
      "-e",
      "POSTGRES_DB=vitalog",
      "-p",
      "127.0.0.1::5432",
      "postgres:17.11",
    ],
    { ...process.env, POSTGRES_PASSWORD: password },
  );
  const port = command(["port", container, "5432/tcp"]).split(":").at(-1)!;
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      command([
        "exec",
        container,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
      ]);
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  assert(ready, "Isolated PostgreSQL did not become ready");
  const url = `postgres://postgres:${password}@127.0.0.1:${port}/vitalog`;
  await migrateDatabase(url);
  connection = database(url);
  await connection.pool.query(
    "insert into account_settings (id, name, time_zone) values (1, 'Fixture', 'Asia/Kolkata') on conflict (id) do update set time_zone = excluded.time_zone",
  );
  service = new Service(connection.db, randomBytes(32).toString("hex"));

  await check(
    "Unrelated historical studies do not consume a narrowed read's bound",
    async () => {
      await insert(cgms(1001, "2026-06-01", "2026-06-30"));
      const daily = await read("health_get_daily_summary", {
        date: fixtureDate,
      });
      assert.equal((daily.overlapping_studies as Data[]).length, 0);
      const context = await read("health_get_context", { lookback_days: 14 });
      assert.equal((context.recent_days as Data[]).length, 0);
      const trend = await read("health_get_trends", {
        metrics: ["measurement:weight"],
        start_date: fixtureDate,
        end_date: fixtureDate,
      });
      assert.equal((trend.metrics as Data[])[0]!.series instanceof Array, true);
      assert.deepEqual((trend.metrics as Data[])[0]!.missing_dates, [
        fixtureDate,
      ]);
      assert.equal(await countRecords(), 1001);
      return 5;
    },
  );
  await check(
    "Requested sections and metric identities are applied before the record bound",
    async () => {
      await reset();
      await insert(cgms(1001, fixtureDate, fixtureDate));
      await assert.rejects(
        () => read("health_get_daily_summary", { date: fixtureDate }),
        { code: "LIMIT_EXCEEDED" },
      );
      const nutrition = await read("health_get_daily_summary", {
        date: fixtureDate,
        sections: ["nutrition"],
      });
      assert.deepEqual(object(nutrition.nutrition).nutrients, {});
      const trend = await read("health_get_trends", {
        metrics: ["measurement:weight", "lab:blood_glucose"],
        start_date: fixtureDate,
        end_date: fixtureDate,
      });
      assert.equal((trend.metrics as Data[]).length, 2);
      const context = await read("health_get_context", {
        lookback_days: 90,
        sections: ["nutrition"],
      });
      assert.equal((context.recent_days as Data[]).length, 0);
      return 4;
    },
  );
  await check(
    "Source filters precede LIMIT and an actually oversized matching window still fails",
    async () => {
      await reset();
      await insert(
        Array.from({ length: 1001 }, () =>
          saved(
            "measurement",
            { kind: "scalar", metric_key: "weight", value: 60, unit: "kg" },
            { provenance: { source_type: "device", value_kind: "measured" } },
          ),
        ),
      );
      const manual = saved("measurement", {
        kind: "scalar",
        metric_key: "weight",
        value: 50,
        unit: "kg",
      });
      await insert([manual]);
      const filtered = await read("health_get_trends", {
        metrics: ["measurement:weight"],
        start_date: fixtureDate,
        end_date: fixtureDate,
        source_type: "manual",
      });
      const series = object(
        ((filtered.metrics as Data[])[0]!.series as Data[])[0],
      );
      assert.equal(object((series.points as Data[])[0]).value, 50);
      assert.deepEqual(object((series.points as Data[])[0]).source_ids, [
        manual.id,
      ]);
      await assert.rejects(
        () =>
          read("health_get_trends", {
            metrics: ["measurement:weight"],
            start_date: fixtureDate,
            end_date: fixtureDate,
          }),
        { code: "LIMIT_EXCEEDED" },
      );
      return 3;
    },
  );
  await check(
    "Known interval observations follow period timezone and do not use the report day",
    async () => {
      await reset();
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
      await insert([study]);
      const observed = await read("health_get_daily_summary", {
        date: fixtureDate,
      });
      assert.equal(
        (observed.overlapping_studies as Data[])[0]!.source_id,
        study.id,
      );
      assert.equal((observed.measurement as Data[]).length, 0);
      const utcCalendarDay = await read("health_get_daily_summary", {
        date: "2026-09-09",
      });
      assert.deepEqual(utcCalendarDay.overlapping_studies, []);
      const report = await read("health_get_daily_summary", {
        date: "2026-09-12",
      });
      assert.deepEqual(report.overlapping_studies, []);
      return 4;
    },
  );
  await check(
    "Context includes overlapping intervals whose report date predates the window",
    async () => {
      await reset();
      const today = localDate(new Date(), "Asia/Kolkata");
      const yesterday = new Date(
        new Date(`${today}T12:00:00Z`).getTime() - 86400000,
      )
        .toISOString()
        .slice(0, 10);
      const study = saved(
        "measurement",
        {
          kind: "study_summary",
          study_type: "cgm_summary",
          components: {},
          effective_period: {
            start: yesterday,
            end: today,
            time_precision: "date",
          },
        },
        { occurred_on: "2026-06-30" },
      );
      await insert([study]);
      const context = await read("health_get_context", { lookback_days: 2 });
      assert.equal((context.recent_days as Data[]).length, 2);
      assert(
        (context.recent_days as Data[]).every(
          (day) =>
            (day.overlapping_studies as Data[])[0]!.source_id === study.id,
        ),
      );
      return 2;
    },
  );
  await check(
    "Unknown interval endpoints remain unknown and disclose unresolved coverage",
    async () => {
      await reset();
      const study = saved("measurement", {
        kind: "study_summary",
        study_type: "cgm_summary",
        components: {},
        effective_period: {
          time_precision: "duration",
          duration_seconds: 172800,
        },
      });
      await insert([study]);
      const report = await read("health_get_daily_summary", {
        date: fixtureDate,
      });
      const period = object((report.overlapping_studies as Data[])[0]!.period);
      assert.equal(period.start, undefined);
      assert.equal(period.end, undefined);
      assert.equal(period.duration_seconds, 172800);
      assert(
        (report.warnings as string[]).includes("unresolved_interval_coverage"),
      );
      const next = await read("health_get_daily_summary", {
        date: "2026-09-11",
      });
      assert.deepEqual(next.overlapping_studies, []);
      return 5;
    },
  );
  await check(
    "Paired blood pressure is a latest context value and invalid pulse stays excluded",
    async () => {
      await reset();
      const bp = saved(
        "measurement",
        {
          kind: "blood_pressure",
          systolic: 120,
          diastolic: 80,
          pulse: 70,
          unit: "mmHg",
        },
        {
          provenance: {
            ...base.provenance,
            field_overrides: { "/pulse": { validity: "invalid" } },
          },
        },
      );
      await insert([bp]);
      const context = await read("health_get_context", { lookback_days: 14 });
      const latest = (context.latest_measurements as Data[])[0]!;
      assert.equal(latest.metric_key, "blood_pressure");
      assert.equal(latest.source_id, bp.id);
      assert.deepEqual(latest.value, {
        kind: "blood_pressure",
        systolic: 120,
        diastolic: 80,
        unit: "mmHg",
      });
      assert.equal(latest.predates_query_window, true);
      return 4;
    },
  );
  await check(
    "Prolonged administrations label overlap without single-day nutrient assignment",
    async () => {
      await reset();
      const intake = saved("intake", {
        product_name: "Synthetic administration",
        category: "medication",
        status: "taken",
        start_at: "2026-09-10T10:00:00+05:30",
        end_at: "2026-09-11T10:00:00+05:30",
        nutrient_contributions: { iron_mg: 10 },
      });
      await insert([intake]);
      for (const date of [fixtureDate, "2026-09-11"]) {
        const summary = await read("health_get_daily_summary", { date });
        assert.deepEqual(object(summary.intake).events, []);
        assert.deepEqual(
          object(object(summary.intake).supplement_nutrients).nutrients,
          {},
        );
        const interval = (summary.overlapping_studies as Data[])[0]!;
        assert.equal(interval.labelled_as, "overlapping_interval_intake");
        assert.equal(interval.source_id, intake.id);
      }
      assert.equal(await countRecords(), 1);
      return 9;
    },
  );
  await check(
    "Explicit intake periods and same-day administrations preserve their distinct semantics",
    async () => {
      await reset();
      const interval = saved("intake", {
        product_name: "Synthetic interval",
        category: "medication",
        status: "taken",
        effective_period: {
          start: fixtureDate,
          end: "2026-09-11",
          time_precision: "date",
        },
        nutrient_contributions: { iron_mg: 10 },
      });
      const sameDay = saved("intake", {
        product_name: "Synthetic dose",
        category: "supplement",
        status: "taken",
        start_at: "2026-09-10T10:00:00+05:30",
        end_at: "2026-09-10T11:00:00+05:30",
        nutrient_contributions: { iron_mg: 2 },
      });
      await insert([interval, sameDay]);
      const first = await read("health_get_daily_summary", {
        date: fixtureDate,
      });
      assert.equal(
        (first.overlapping_studies as Data[])[0]!.source_id,
        interval.id,
      );
      assert.equal(
        object(
          object(object(object(first.intake).supplement_nutrients).nutrients)
            .iron_mg,
        ).exact_value,
        2,
      );
      const second = await read("health_get_daily_summary", {
        date: "2026-09-11",
      });
      assert.deepEqual(object(second.intake).events, []);
      assert.equal(
        (second.overlapping_studies as Data[])[0]!.source_id,
        interval.id,
      );
      return 4;
    },
  );

  await check(
    "A caller-selected history limit retrieves all large admitted snapshots without loss",
    async () => {
      await reset();
      const entry = saved("nutrition", {
        entry_kind: "intake",
        nutrients: Object.fromEntries(nutrientKeys.map((key) => [key, 1])),
        component_details: Object.fromEntries(
          nutrientKeys.map((key) => [
            key,
            {
              expression_basis: "s".repeat(100),
              form: "s".repeat(100),
              method: "s".repeat(200),
              definition: "s".repeat(300),
              definition_version: "s".repeat(100),
              coverage: "s".repeat(200),
              source_definition_reference: "s".repeat(200),
            },
          ]),
        ),
      });
      assert(Buffer.byteLength(JSON.stringify(entry)) < 1024 * 1024);
      entry.version = 105;
      await insert([entry]);
      await connection!.db.insert(revisions).values(
        Array.from({ length: 105 }, (_, index) => ({
          recordId: entry.id,
          version: index + 1,
          snapshot: { ...entry, version: index + 1 },
          changedAt: entry.updated_at,
          reason: "Synthetic history verification",
        })),
      );
      await assert.rejects(
        () =>
          read("health_get_record", {
            id: entry.id,
            include_history: true,
          }),
        { code: "LIMIT_EXCEEDED" },
      );
      const versions: number[] = [];
      let cursor: number | undefined;
      let pages = 0;
      let assertions = 2;
      do {
        const result = await read("health_get_record", {
          id: entry.id,
          include_history: true,
          history_limit: 7,
          ...(cursor ? { history_before_version: cursor } : {}),
        });
        const page = result.history as { version: number }[];
        assert.equal(page.length, 7);
        assert.equal(object(result.record).version, 105);
        assert(Buffer.byteLength(JSON.stringify(result)) < 8 * 1024 * 1024);
        versions.push(...page.map((revision) => revision.version));
        assert.equal(result.history_has_more, versions.length < 105);
        assert.equal(
          result.history_next_version,
          versions.length < 105 ? page.at(-1)!.version : null,
        );
        cursor = result.history_has_more
          ? Number(result.history_next_version)
          : undefined;
        pages++;
        assertions += 5;
      } while (cursor);
      assert.deepEqual(
        versions,
        Array.from({ length: 105 }, (_, index) => 105 - index),
      );
      assert.equal(new Set(versions).size, 105);
      assert.equal(pages, 15);
      return assertions + 3;
    },
  );

  await mkdir(".test-artifacts", { recursive: true });
  const version = await connection.db.execute<{ server_version: string }>(
    sql`select current_setting('server_version') as server_version`,
  );
  await writeFile(
    ".test-artifacts/summary.json",
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        status: "passed",
        mode: "shared_domain_with_real_postgresql",
        environment: {
          node: process.version,
          postgresql: version.rows[0]!.server_version,
        },
        synthetic_only: true,
        checks,
        check_count: checks.length,
        assertion_count: checks.reduce(
          (total, entry) => total + entry.assertions,
          0,
        ),
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(
    `PASS ${checks.length} PostgreSQL summary verification groups\n`,
  );
} finally {
  await connection?.pool.end();
  try {
    command(["rm", "--force", container]);
  } catch {
    process.stderr.write(
      `Could not remove isolated test container ${container}\n`,
    );
  }
}
