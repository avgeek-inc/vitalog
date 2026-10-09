import { issueMcpFixtureToken, mcpFixtureIssuer } from "./mcp-fixture.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { once } from "node:events";
import { request as httpRequest, Server } from "node:http";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { application } from "../src/app.js";
import { configuration } from "../src/config.js";
import { database } from "../src/db/client.js";
import { Service } from "../src/service.js";
import { migrateDatabase } from "./migrate.js";
import {
  CATALOG_VERSION,
  inventory,
  nutrientKeys,
  analyteKeys,
  measurementKeys,
  moodValues,
} from "../src/registry/definitions.js";
import { operations } from "../src/registry/operations.js";
import { object, type Data, type HealthRecord } from "../src/domain/types.js";
import { hash } from "../src/domain/canonical.js";
import {
  base,
  examples,
  fixtureDate,
  labFixture,
  measurementFixture,
} from "../tests/fixtures.js";

const container = `vitalog-verification-${process.pid}`;
const password = randomBytes(32).toString("hex");
let key = randomBytes(32).toString("base64url");
const checks: { name: string; status: "passed"; assertions: number }[] = [];
const covered: Record<string, string[]> = {
  nutrients: [],
  lab_analytes: [],
  measurements: [],
};
const logs: Data[] = [];
const command = (
  args: string[],
  options: { input?: string | Buffer; env?: NodeJS.ProcessEnv } = {},
) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 40 * 1024 * 1024,
    ...options,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
let dbUrl = "";
let connection: ReturnType<typeof database> | undefined;
let server: Server | undefined;
let mcpToken = "";
let client: Client | undefined;
let baseUrl = "";
async function check(name: string, fn: () => Promise<number | void>) {
  process.stdout.write(`RUN ${name}\n`);
  const count = await fn();
  checks.push({ name, status: "passed", assertions: count ?? 1 });
  process.stdout.write(`PASS ${name}\n`);
}
async function startApi() {
  connection = database(dbUrl);
  await connection.pool.query(
    "insert into account_settings (id, name, time_zone) values (1, 'Fixture', 'Asia/Kolkata') on conflict (id) do update set time_zone = excluded.time_zone",
  );
  const config = configuration({
    AUTH_KEY: key,
    PUBLIC_BASE_URL: mcpFixtureIssuer,
    DATABASE_URL: dbUrl,

    RATE_LIMIT_PER_MINUTE: "100000",
  });
  const service = new Service(connection.db, config.authDigest.toString("hex"));
  const api = application(service, config, (entry) => {
    logs.push(entry);
  });
  const instance = serve({ fetch: api.fetch, port: 0, hostname: "127.0.0.1" });
  assert(instance instanceof Server);
  server = instance;
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
  config.allowedHosts = [`127.0.0.1:${address.port}`];
  await newClient();
}
async function newClient() {
  mcpToken = await issueMcpFixtureToken(
    connection!.db,
    mcpFixtureIssuer + "/mcp",
  );
  client = new Client({
    name: "vitalog-interoperability-test",
    version: "1.0.0",
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(baseUrl + "/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } },
    }),
  );
}
async function stopApi() {
  await client?.close();
  client = undefined;
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server.closeAllConnections();
    server = undefined;
  }
  await connection?.pool.end();
  connection = undefined;
}
async function rest(
  path: string,
  data?: Data,
  idem: string = randomUUID(),
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Data; response: Response }> {
  const response = await fetch(baseUrl + path, {
    method: data ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${path === "/mcp" ? mcpToken : key}`,
      ...(data
        ? { "Content-Type": "application/json", "Idempotency-Key": idem }
        : {}),
      ...headers,
    },
    body: data ? JSON.stringify(data) : undefined,
  }).catch((error: unknown) => {
    throw new Error(`REST transport failed for ${path}`, { cause: error });
  });
  return {
    status: response.status,
    body: object(await response.json()),
    response,
  };
}
async function call(name: string, args: Data): Promise<Data> {
  const response = await client!
    .callTool({ name, arguments: args })
    .catch((error: unknown) => {
      throw new Error(`MCP transport failed for ${name}`, { cause: error });
    });
  if (response.isError)
    throw new Error(
      `MCP ${name}: ${JSON.stringify(response.content).slice(0, 600)}`,
    );
  const output = object(response.structuredContent);
  operations.find((op) => op.name === name)!.output.parse(output);
  return output;
}
async function mcpFailure(name: string, args: Data): Promise<Data> {
  const response = await client!
    .callTool({ name, arguments: args })
    .catch((error: unknown) => {
      throw new Error(`MCP failure transport failed for ${name}`, {
        cause: error,
      });
    });
  assert(response.isError);
  const content = response.content as { type: string; text: string }[];
  return object(JSON.parse(content[0]!.text));
}
async function reset() {
  await connection!.pool.query(
    "TRUNCATE record_attachments, record_revisions, idempotency_requests, health_records",
  );
}
async function counts() {
  return (
    await connection!.pool.query(
      "SELECT (SELECT count(*)::int FROM health_records) records, (SELECT count(*)::int FROM record_revisions) revisions, (SELECT count(*)::int FROM idempotency_requests) idempotency",
    )
  ).rows[0] as { records: number; revisions: number; idempotency: number };
}
async function save(
  type: keyof typeof examples,
  data: Data,
  idem: string = randomUUID(),
): Promise<HealthRecord> {
  const op = operations.find((op) => op.record_type === type)!;
  const args = { ...base, data };
  const response = await rest(
    op.path,
    op.batch ? { records: [args] } : args,
    idem,
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return (
    op.batch
      ? (response.body.records as HealthRecord[])[0]
      : response.body.record
  ) as HealthRecord;
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
      "POSTGRES_USER=vitalog",
      "-e",
      "POSTGRES_DB=vitalog",
      "-p",
      "127.0.0.1::5432",
      "postgres:17.11-bookworm",
    ],
    { env: { ...process.env, POSTGRES_PASSWORD: password } },
  );
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      command([
        "exec",
        container,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "vitalog",
        "-d",
        "vitalog",
      ]);
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  assert(ready, "Disposable PostgreSQL did not become ready");
  const port = command(["port", container, "5432/tcp"]).split(":").at(-1)!;
  dbUrl = `postgresql://vitalog:${password}@127.0.0.1:${port}/vitalog`;
  await migrateDatabase(dbUrl);
  await migrateDatabase(dbUrl);
  await startApi();
  const postgresVersion = (await connection!.pool.query("SHOW server_version"))
    .rows[0].server_version;
  await check(
    "Fresh installation, repeatable Drizzle migrations, empty database and readiness",
    async () => {
      assert.deepEqual(await counts(), {
        records: 0,
        revisions: 0,
        idempotency: 0,
      });
      assert.equal((await rest("/readyz")).status, 200);
      assert.equal((await fetch(baseUrl + "/healthz")).status, 200);
    },
  );
  await check(
    "Authenticated MCP initialization, all registered tools, schemas, annotations and no UI resources",
    async () => {
      const result = await client!.listTools();
      assert.equal(result.tools.length, operations.length);
      assert.deepEqual(
        result.tools.map((tool) => tool.name).sort(),
        operations.map((op) => op.name).sort(),
      );
      for (const tool of result.tools) {
        assert(tool.inputSchema.properties);
        assert(tool.outputSchema);
        assert.equal(tool.annotations?.openWorldHint, false);
        assert.equal(
          tool.annotations?.readOnlyHint,
          !operations.find((op) => op.name === tool.name)!.mutation,
        );
      }
      assert(!JSON.stringify(result).includes(key));
      return operations.length;
    },
  );
  await check(
    "Unauthenticated, invalid, duplicate and malformed authorization fail before REST/MCP discovery",
    async () => {
      for (const path of [
        "/v1/catalog",
        "/v1/records",
        "/openapi.json",
        "/readyz",
        "/mcp",
      ]) {
        for (const header of [
          undefined,
          "Bearer wrong",
          `Bearer  ${key}`,
          `Bearer ${key}, Bearer ${key}`,
        ]) {
          let r: Response;
          try {
            r = await fetch(baseUrl + path, {
              headers: header ? { Authorization: header } : {},
            });
          } catch (error) {
            throw new Error(
              `Unauthorized transport request failed: ${path}, header case ${header ? "invalid" : "missing"}`,
              { cause: error },
            );
          }
          assert.equal(r.status, 401);
          const body = await r.text();
          assert(!body.includes("analyte_keys"));
          assert(!body.includes(key));
        }
      }
      const status = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          baseUrl + "/v1/catalog",
          {
            headers: [
              "Host",
              new URL(baseUrl).host,
              "Authorization",
              `Bearer ${key}`,
              "Authorization",
              `Bearer ${key}`,
            ],
          },
          (response) => {
            response.resume();
            resolve(response.statusCode!);
          },
        );
        request.on("error", reject);
        request.end();
      });
      assert.equal(status, 401);
      return 21;
    },
  );
  await check(
    "Host/origin protection and authenticated stateless transport method handling",
    async () => {
      assert.equal(
        (
          await rest("/v1/catalog", undefined, "unused", {
            Origin: "https://untrusted.example",
          })
        ).status,
        403,
      );
      const origin = await fetch(baseUrl + "/mcp", {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${mcpToken}`,
          Origin: "https://untrusted.example",
        },
      });
      assert.equal(origin.status, 403);
      for (const method of ["GET", "DELETE"]) {
        const r = await fetch(baseUrl + "/mcp", {
          method,
          headers: {
            Authorization: `Bearer ${mcpToken}`,
            Accept: "text/event-stream",
          },
        });
        assert.equal(r.status, 200);
        await r.text();
      }
      const missingAccept = await fetch(baseUrl + "/mcp", {
        headers: {
          Authorization: `Bearer ${mcpToken}`,
          Accept: "application/json",
        },
      });
      assert.equal(missingAccept.status, 406);
    },
  );
  await check(
    "REST/MCP catalog parity, empty-state purity, complete groups, strict queries and version mismatches",
    async () => {
      assert.deepEqual(
        (await rest("/v1/catalog")).body,
        await call("health_get_catalog", {}),
      );
      for (const panel of inventory.lab_panels) {
        const r = await call("health_get_catalog", {
          category: "lab_analytes",
          panel_key: panel.panel_key,
          limit: 100,
        });
        assert.deepEqual(
          (r.items as Data[]).map((item) => item.key).sort(),
          [...panel.analyte_keys].sort(),
        );
      }
      for (const query of [
        "limit=2&limit=3",
        "category=",
        "category=nutrients&include_schema=1",
        "limit=-1",
        "unknown=foo",
      ])
        assert.equal((await rest("/v1/catalog?" + query)).status, 422);
      assert.equal(
        (await rest("/v1/catalog?category=lab_analytes&key=unknown")).status,
        404,
      );
      assert.equal(
        (await rest("/v1/catalog?catalog_version=0.9.0")).status,
        409,
      );
      const page = await call("health_get_catalog", {
        category: "nutrients",
        limit: 2,
      });
      assert.equal(
        (
          await mcpFailure("health_get_catalog", {
            category: "nutrients",
            limit: 3,
            cursor: page.next_cursor,
          })
        ).code,
        "VALIDATION_ERROR",
      );
      assert.equal((await counts()).records, 0);
      return 39;
    },
  );
  await check(
    "Every advertised nutrient accepts REST and MCP writes and typed corrections",
    async () => {
      for (const nutrient of nutrientKeys) {
        const op = operations.find(
          (operation) => operation.record_type === "nutrition",
        )!;
        const data = { entry_kind: "intake", nutrients: { [nutrient]: 0.125 } };
        const r = await save("nutrition", data);
        const m = await call(op.name, {
          idempotency_key: `coverage-${nutrient}`,
          ...base,
          data,
        });
        assert.deepEqual(
          object(object(m.record).data).nutrients,
          data.nutrients,
        );
        const corrected = await call("health_correct_record", {
          id: r.id,
          idempotency_key: `correction-${nutrient}`,
          expected_version: 1,
          reason: "Synthetic coverage correction",
          replacement: { record_type: "nutrition", ...base, data },
        });
        assert.equal(object(corrected.record).version, 2);
        covered.nutrients!.push(nutrient);
      }
      await reset();
      return nutrientKeys.length * 3;
    },
  );
  await check(
    "All 110 measurement keys accept both transports, corrections and component projections",
    async () => {
      for (const metric of measurementKeys) {
        const data = measurementFixture(metric);
        const r = await save("measurement", data);
        const m = await call("health_log_measurements", {
          idempotency_key: `coverage-${metric}`,
          records: [{ ...base, data }],
        });
        assert.equal((m.records as Data[])[0]!.record_type, "measurement");
        const corrected = await call("health_correct_record", {
          id: r.id,
          idempotency_key: `correction-${metric}`,
          expected_version: 1,
          reason: "Synthetic coverage correction",
          replacement: { record_type: "measurement", ...base, data },
        });
        assert.equal(object(corrected.record).version, 2);
        covered.measurements!.push(metric);
      }
      await reset();
      return measurementKeys.length * 3;
    },
  );
  await check(
    "All 424 analytes, overlapping panels, typed uncommon results and corrections round-trip through REST/MCP",
    async () => {
      for (const analyte of analyteKeys) {
        const data = labFixture(analyte);
        const r = await save("lab_result", data);
        const m = await call("health_log_lab_results", {
          idempotency_key: `coverage-${analyte}`,
          records: [{ ...base, data }],
        });
        assert.deepEqual(
          object((m.records as Data[])[0]!.data).result,
          data.result,
        );
        const correction = await call("health_correct_record", {
          id: r.id,
          idempotency_key: `correction-${analyte}`,
          expected_version: 1,
          reason: "Synthetic coverage correction",
          replacement: { record_type: "lab_result", ...base, data },
        });
        assert.equal(object(correction.record).version, 2);
        covered.lab_analytes!.push(analyte);
      }
      await reset();
      return analyteKeys.length * 3;
    },
  );
  await check(
    "Atomic batches roll back all rows/revisions/idempotency on invalid members; shared lab metadata works",
    async () => {
      const before = await counts();
      const r = await rest("/v1/measurements", {
        records: [
          examples.measurement,
          {
            ...base,
            data: {
              kind: "scalar",
              metric_key: "weight",
              value: 2,
              unit: "unrecognized",
            },
          },
        ],
      });
      assert.equal(r.status, 422);
      assert.deepEqual(await counts(), before);
      const labs = await mcpFailure("health_log_lab_results", {
        idempotency_key: "atomic-bad-labs",
        records: [
          examples.lab_result,
          {
            ...base,
            data: {
              ...labFixture("hemoglobin"),
              result: { kind: "titer", dilution_text: "1:160" },
            },
          },
        ],
      });
      assert.equal(labs.code, "VALIDATION_ERROR");
      assert.deepEqual(await counts(), before);
      const good = await call("health_log_lab_results", {
        idempotency_key: "shared-labs",
        shared_metadata: {
          provenance: base.provenance,
          laboratory: "Synthetic laboratory",
          collected_on: fixtureDate,
        },
        records: [
          { data: { ...labFixture("hemoglobin"), collected_on: undefined } },
          { data: { ...labFixture("hematocrit"), collected_on: undefined } },
        ],
      });
      assert.equal((good.records as Data[]).length, 2);
      assert.equal(
        object((good.records as Data[])[0]!.data).laboratory,
        "Synthetic laboratory",
      );
      await reset();
    },
  );
  let saved: HealthRecord;
  await check(
    "Concurrent and cross-interface idempotency creates one event; changed payload conflicts",
    async () => {
      const data = examples.nutrition;
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          rest("/v1/nutrition", data as unknown as Data, "concurrent"),
        ),
      );
      results.forEach((result) => assert.equal(result.status, 200));
      saved = results[0]!.body.record as HealthRecord;
      assert.equal((await counts()).records, 1);
      const retry = await call("health_log_nutrition", {
        idempotency_key: "concurrent",
        ...data,
      });
      assert.equal(object(retry.record).id, saved.id);
      assert.equal(retry.idempotent_replay, true);
      assert.equal(
        (
          await rest(
            "/v1/nutrition",
            {
              ...data,
              data: { entry_kind: "intake", nutrients: { energy_kcal: 1 } },
            },
            "concurrent",
          )
        ).status,
        409,
      );
    },
  );
  await check(
    "Optimistic corrections, history, type immutability, void and replay after a later revision",
    async () => {
      assert.equal(
        (
          await rest(`/v1/records/${saved!.id}/corrections`, {
            expected_version: 2,
            reason: "Synthetic",
            replacement: { record_type: "nutrition", ...examples.nutrition },
          })
        ).status,
        409,
      );
      const corrected = await rest(
        `/v1/records/${saved!.id}/corrections`,
        {
          expected_version: 1,
          reason: "Synthetic",
          replacement: {
            record_type: "nutrition",
            ...base,
            data: { entry_kind: "intake", nutrients: { energy_kcal: 500 } },
          },
        },
        "correct-one",
      );
      assert.equal(corrected.status, 200);
      const replay = await rest(
        "/v1/nutrition",
        examples.nutrition as unknown as Data,
        "concurrent",
      );
      assert.equal(object(replay.body.record).version, 1);
      assert.equal(object(object(replay.body.record).data).label, "Lunch");
      assert.equal(
        (
          await rest(`/v1/records/${saved!.id}/voids`, {
            expected_version: 2,
            reason: "Synthetic void",
          })
        ).status,
        200,
      );
      const read = await call("health_get_record", {
        id: saved!.id,
        include_history: true,
      });
      assert.equal((read.history as Data[]).length, 3);
      assert.equal(object(read.record).status, "voided");
      const correctedVoid = await call("health_correct_record", {
        id: saved!.id,
        idempotency_key: "correct-void",
        expected_version: 3,
        reason: "Synthetic correction",
        replacement: { record_type: "nutrition", ...examples.nutrition },
      });
      assert.equal(object(correctedVoid.record).status, "voided");
      assert.equal((await call("health_list_records", {})).returned_count, 0);
    },
  );
  await check(
    "Restart, key rotation and fresh authorized client preserve committed retries and stored history",
    async () => {
      const id = saved!.id;
      const oldKey = key;
      await stopApi();
      key = randomBytes(32).toString("base64url");
      await startApi();
      assert.equal(
        (
          await rest("/v1/catalog", undefined, "unused", {
            Authorization: `Bearer ${oldKey}`,
          })
        ).status,
        401,
      );
      const read = await call("health_get_record", { id });
      assert.equal(object(read.record).version, 4);
      const retry = await call("health_log_nutrition", {
        idempotency_key: "concurrent",
        ...examples.nutrition,
      });
      assert.equal(object(retry.record).version, 1);
      assert.equal(retry.idempotent_replay, true);
      await reset();
    },
  );
  await check(
    "Daily totals, qualified precedence, estimate provenance, per-field validity and domain separation",
    async () => {
      const first = await save("nutrition", {
        entry_kind: "intake",
        nutrients: { energy_kcal: 430, protein_g: 26, added_sugars_g: 2 },
      });
      const total = await save("nutrition", {
        entry_kind: "daily_total",
        nutrients: { energy_kj: 7949.6, protein_g: 100, added_sugars_g: 0.5 },
        nutrient_qualifiers: {
          added_sugars_g: { kind: "bound", comparator: "lt" },
        },
      });
      assert.equal(
        (
          await rest("/v1/nutrition", {
            ...base,
            data: {
              entry_kind: "daily_total",
              nutrients: { energy_kcal: 2000 },
            },
          })
        ).status,
        409,
      );
      const warning = await rest("/v1/nutrition", {
        ...base,
        data: { entry_kind: "intake", nutrients: { energy_kcal: 50 } },
      });
      assert(
        (warning.body.warnings as string[]).includes("daily_total_present"),
      );
      await save("hydration", {
        entry_kind: "intake",
        volume_ml: 250,
        drink_type: "water",
      });
      await save("hydration", {
        entry_kind: "daily_total",
        total_fluids_ml: 1000,
        water_ml: 500,
      });
      assert.equal(
        (
          await rest("/v1/hydration", {
            ...base,
            data: { entry_kind: "daily_total", total_fluids_ml: 50 },
          })
        ).status,
        409,
      );
      const workout = await rest("/v1/activities", {
        ...base,
        provenance: {
          source_type: "manual",
          value_kind: "estimated",
          field_overrides: {
            "/average_heart_rate_bpm": {
              validity: "invalid",
              reason: "No hand sensors",
            },
          },
        },
        data: { ...examples.activity.data, average_heart_rate_bpm: 100 },
      });
      assert.equal(workout.status, 200);
      await save("activity", {
        entry_kind: "daily_total",
        daily_totals: { active_energy_kcal: 400 },
      });
      assert.equal(
        (
          await rest("/v1/activities", {
            ...base,
            data: { entry_kind: "daily_total", daily_totals: { steps: 2 } },
          })
        ).status,
        409,
      );
      await save("intake", {
        product_name: "Synthetic supplement",
        category: "supplement",
        status: "taken",
        nutrient_contributions: { protein_g: 1 },
      });
      const day = (await rest(`/v1/days/${fixtureDate}`)).body;
      assert.deepEqual(
        day,
        await call("health_get_daily_summary", { date: fixtureDate }),
      );
      assert.equal(object(object(day.nutrition).energy).exact_value, 1900);
      assert.equal(
        object(object(object(day.nutrition).nutrients).added_sugars_g)
          .exact_value,
        null,
      );
      assert.equal(
        object(object(day.hydration).total_fluids_ml).exact_value,
        1000,
      );
      assert(
        !(
          "average_heart_rate_bpm" in
          object((object(day.activity).workouts as Data[])[0]!.data)
        ),
      );
      assert.equal(object(day.intake).combined_dietary_supplement_total, null);
      const correction = await rest(`/v1/records/${total.id}/corrections`, {
        expected_version: 1,
        reason: "Synthetic",
        replacement: {
          record_type: "nutrition",
          ...base,
          data: { entry_kind: "daily_total", nutrients: { energy_kcal: 1800 } },
        },
      });
      assert.equal(correction.status, 200);
      assert.equal(
        object(
          object((await rest(`/v1/days/${fixtureDate}`)).body.nutrition).energy,
        ).exact_value,
        1800,
      );
      assert(first.id);
      await reset();
    },
  );
  await check(
    "Sparse partitioned trends, weight moving averages, undated lab reads and source-status exclusions",
    async () => {
      await save("measurement", { ...measurementFixture("weight"), value: 70 });
      await save("measurement", { ...measurementFixture("weight"), value: 71 });
      const args = {
        metrics: ["measurement:weight"],
        start_date: fixtureDate,
        end_date: "2026-09-12",
      };
      const trend = await call("health_get_trends", args);
      assert.deepEqual(
        trend,
        (
          await rest(
            `/v1/trends?metrics=measurement:weight&start_date=${fixtureDate}&end_date=2026-09-12`,
          )
        ).body,
      );
      const series = (trend.metrics as Data[])[0]!.series as Data[];
      const points = series[0]!.points as Data[];
      assert.equal(points[0]!.value, 71);
      assert.equal(points[1]!.value, null);
      assert.equal(points[1]!.contributing_days, 1);
      const invalid = await rest("/v1/lab-results", {
        records: [
          {
            provenance: base.provenance,
            data: {
              ...labFixture("hemoglobin"),
              collected_on: undefined,
              result: { kind: "absent", reason: "pending" },
            },
          },
        ],
      });
      assert.equal(invalid.status, 200);
      assert.equal(
        (
          await rest(
            `/v1/records?record_types=lab_result&start_date=${fixtureDate}`,
          )
        ).body.returned_count,
        0,
      );
      assert.equal(
        (
          await rest(
            `/v1/records?record_types=lab_result&start_date=${fixtureDate}&include_undated=true`,
          )
        ).body.returned_count,
        1,
      );
      await save("lab_result", {
        ...labFixture("hemoglobin"),
        result: { kind: "quantity", value: 4, unit: "g/dL" },
        source_status: "preliminary",
      });
      const labs = await call("health_get_trends", {
        ...args,
        metrics: ["lab:hemoglobin"],
      });
      assert.equal((labs.metrics as Data[])[0]!.exclusions, 1);
      const preliminary = await call("health_get_trends", {
        ...args,
        metrics: ["lab:hemoglobin"],
        include_preliminary: true,
      });
      assert.equal((preliminary.metrics as Data[])[0]!.exclusions, 0);
      for (const [method, unit] of [
        ["Synthetic assay A", "g/dL"],
        ["Synthetic assay B", "g/dL"],
        ["Synthetic assay A", "unfamiliar-preserved-unit"],
      ])
        await save("lab_result", {
          ...labFixture("hemoglobin"),
          method: { name: method },
          result: { kind: "quantity", value: "10.00", unit },
          source_status: "final",
        });
      const partitioned = await call("health_get_trends", {
        ...args,
        metrics: ["lab:hemoglobin"],
      });
      const partitions = (partitioned.metrics as Data[])[0]!.series as Data[];
      assert.equal(partitions.length, 4);
      assert(
        partitions.every(
          (series) =>
            series.aggregation === "individual_irregular_observations",
        ),
      );
      assert(
        partitions.some(
          (series) =>
            object(series.identity).unit === "unfamiliar-preserved-unit",
        ),
      );
      const context = await call("health_get_context", {});
      assert(!("recent_labs" in context));
      assert.equal(context.undated_lab_count, 1);
      await reset();
    },
  );
  await check(
    "Detailed study, sleep, strength, check-in, medication and assay context survives reads and corrections",
    async () => {
      const detailed = {
        measurement: {
          kind: "study_summary",
          study_type: "cgm_summary",
          effective_period: {
            start: "2026-09-01",
            end: "2026-09-15",
            time_precision: "date",
          },
          coverage: {
            expected_samples: 100,
            observed_samples: 80,
            percent: 80,
          },
          components: {
            interstitial_glucose: {
              value: { kind: "quantity", value: "110.0", unit: "mg/dL" },
              context: {
                specimen: "other",
                method: { name: "Supplied sensor method" },
              },
            },
          },
          cgm: {
            mean_glucose: { kind: "quantity", value: 110, unit: "mg/dL" },
            reported_gmi_percent: 6,
            bands: [
              {
                label: "Source band",
                lower: 70,
                upper: 180,
                unit: "mg/dL",
                percent: 80,
                denominator: "observed readings",
              },
            ],
          },
        },
        activity: {
          ...examples.activity.data,
          moving_seconds: 800,
          paused_seconds: 100,
          cadence: 80,
          cadence_unit: "steps_per_minute",
          mechanical_work_kj: 10,
          segments: [
            { index: 1, type: "lap", elapsed_seconds: 300, distance_m: 200 },
          ],
          strength: [
            {
              exercise_name: "Supplied exercise",
              set_index: 1,
              repetitions: 8,
              load: { kind: "quantity", value: 5, unit: "kg" },
              load_interpretation: "per_hand",
              repetitions_in_reserve: 2,
              exertion: { scale: "cr10", value: 7 },
            },
          ],
        },
        sleep: {
          entry_kind: "session",
          session_type: "main",
          start_at: "2026-09-09T22:00:00+05:30",
          end_at: "2026-09-10T06:00:00+05:30",
          time_in_bed_seconds: 28800,
          sleep_seconds: 24000,
          stage_system: "reported_n_stages",
          stage_durations: { n1: 1000, n2: 10000, n3: 5000, rem: 8000 },
          respiratory_events: {
            ahi: { value: 2, denominator: "sleep_hours" },
            rei: { value: 1.5, denominator: "monitoring_hours" },
            supine: {
              value: 3,
              denominator: "sleep_hours",
              duration_seconds: 1000,
            },
          },
          oxygen_summary: {
            mean_percent: 97,
            nadir_percent: 92,
            desaturation_definition: "Supplied 3% definition",
            time_below_threshold: [
              {
                label: "Supplied threshold",
                upper: 90,
                unit: "%",
                duration_seconds: 0,
                denominator: "recording seconds",
              },
            ],
          },
          pap_session: {
            mode: "Reported mode",
            pressure: { kind: "quantity", value: 8, unit: "cmH2O" },
            use_seconds: 24000,
            leak: {
              value: 5,
              unit: "L/min",
              basis: "percentile",
              percentile: 95,
            },
          },
        },
        checkin: {
          mood: "good",
          ratings: {
            pain: {
              value: 3,
              scale: "reported_0_10",
              lower: 0,
              upper: 10,
              direction: "higher_is_more",
              meaning: "Supplied pain rating",
            },
          },
          symptoms: [
            {
              name: "Supplied symptom",
              laterality: "left",
              duration_seconds: 60,
              course: "improving",
              severity: { value: 2, scale: "supplied", lower: 0, upper: 5 },
            },
          ],
          diary_completeness: {
            nutrition: "partial",
            reported_at: "2026-09-10T10:00:00Z",
          },
          urinary: { void_count: 4, visible_blood: null },
          reproductive: {
            spotting_amount: { value: 1, scale: "source_scale" },
          },
          assessment_results: [
            {
              instrument: "Supplied assessment",
              version: "1",
              score: { value: 5, scale: "reported", lower: 0, upper: 10 },
              date: fixtureDate,
              completion_status: "completed",
            },
          ],
          actual_fasting_interval: {
            start: "2026-09-09T18:00:00Z",
            end: "2026-09-10T06:00:00Z",
            time_precision: "instant",
            duration_seconds: 43200,
          },
        },
        intake: {
          product_name: "Synthetic administered product",
          category: "medication",
          status: "partially_taken",
          administered_quantity: {
            kind: "quantity",
            value: "0.5",
            unit: "tablet",
          },
          ingredients: [
            {
              compound_name: "Supplied salt",
              compound_mass: { kind: "quantity", value: 100, unit: "mg" },
              elemental_amount: { kind: "quantity", value: 20, unit: "mg" },
              strength: {
                numerator: { kind: "quantity", value: 100, unit: "mg" },
                denominator: { kind: "quantity", value: 1, unit: "tablet" },
                basis: "per_tablet",
              },
            },
          ],
          route: "oral",
          taken_with_food: null,
          nutrient_contributions: { iron_mg: 10 },
        },
        lab_result: {
          ...labFixture("egfr"),
          result: { kind: "quantity", value: 70, unit: "mL/min/1.73m2" },
          quantity_context: {
            bsa_normalization: "indexed_1_73_m2",
            equation: "Supplied equation",
            marker_basis: "creatinine",
          },
          reference_ranges: [
            {
              lower: 60,
              upper: 100,
              method: "A",
              sex_context: "source supplied",
              pregnancy_context: "source context",
            },
            { lower: 50, upper: 90, method: "B" },
          ],
          report_revision: "amended source report",
          source_status: "amended",
        },
      };
      for (const [type, data] of Object.entries(detailed)) {
        const created = await save(type as keyof typeof examples, data);
        assert.deepEqual(created.data, data);
        const read = await call("health_get_record", { id: created.id });
        assert.deepEqual(object(read.record).data, data);
        const correction = await call("health_correct_record", {
          id: created.id,
          idempotency_key: `details-${type}`,
          expected_version: 1,
          reason: "Synthetic correction",
          replacement: { record_type: type, ...base, data },
        });
        assert.deepEqual(object(correction.record).data, data);
      }
      const day = await call("health_get_daily_summary", { date: fixtureDate });
      assert.equal((day.overlapping_studies as Data[]).length, 1);
      assert.equal(object(day.sleep).exact_value, 24000);
      const studyTrend = await call("health_get_trends", {
        metrics: ["measurement:interstitial_glucose"],
        start_date: fixtureDate,
        end_date: "2026-09-12",
      });
      const studySeries = (
        object((studyTrend.metrics as Data[])[0]).series as Data[]
      )[0]!;
      assert.equal(
        studySeries.aggregation,
        "individual_irregular_observations",
      );
      assert.equal(
        (studySeries.observations as Data[])[0]!.component_path,
        "/components/interstitial_glucose/value",
      );
      assert.deepEqual(studySeries.points, []);
      assert.equal(
        object(object(day.diary_completeness).nutrition).value,
        "partial",
      );
      await reset();
      return 22;
    },
  );
  await check(
    "Nutrient series separate expression bases and context uses the latest usable historical value",
    async () => {
      await save("nutrition", {
        entry_kind: "intake",
        nutrients: { carbohydrate_g: 5 },
      });
      await rest("/v1/nutrition", {
        ...base,
        occurred_on: "2026-09-11",
        data: {
          entry_kind: "intake",
          nutrients: { carbohydrate_g: 6 },
          component_details: {
            carbohydrate_g: { expression_basis: "available" },
          },
        },
      });
      const trend = await call("health_get_trends", {
        metrics: ["nutrient:carbohydrate_g"],
        start_date: fixtureDate,
        end_date: "2026-09-11",
      });
      assert.equal(((trend.metrics as Data[])[0]!.series as Data[]).length, 2);
      const good = await save("measurement", {
        ...measurementFixture("weight"),
        value: { kind: "quantity", value: "70.00", unit: "kg" },
      });
      await rest("/v1/measurements", {
        records: [
          {
            ...base,
            occurred_on: "2026-09-11",
            provenance: {
              ...base.provenance,
              field_overrides: {
                "/value/value": {
                  validity: "invalid",
                  reason: "Synthetic unreliable reading",
                },
              },
            },
            data: {
              ...measurementFixture("weight"),
              value: { kind: "quantity", value: "200.00", unit: "kg" },
            },
          },
        ],
      });
      const context = await call("health_get_context", {});
      assert.equal(
        (context.latest_measurements as Data[])[0]!.source_id,
        good.id,
      );
      assert.equal(
        (context.latest_measurements as Data[])[0]!.predates_query_window,
        true,
      );
      await reset();
    },
  );
  await check(
    "Precise observation ordering, complete context partitions and explicit read limits",
    async () => {
      const newer = await rest("/v1/measurements", {
        records: [
          {
            ...base,
            occurred_at: "2026-09-10T02:00:00Z",
            data: { ...measurementFixture("weight"), value: 72 },
          },
        ],
      });
      assert.equal(newer.status, 200);
      const earlier = await rest("/v1/measurements", {
        records: [
          {
            ...base,
            occurred_at: "2026-09-10T01:00:00Z",
            data: { ...measurementFixture("weight"), value: 71 },
          },
        ],
      });
      assert.equal(earlier.status, 200);
      const trend = await call("health_get_trends", {
        metrics: ["measurement:weight"],
        start_date: fixtureDate,
        end_date: fixtureDate,
      });
      assert.equal(
        (
          ((trend.metrics as Data[])[0]!.series as Data[])[0]!.points as Data[]
        )[0]!.value,
        72,
      );
      const latest = await call("health_get_context", {});
      assert.equal((latest.latest_measurements as Data[])[0]!.value, 72);
      await reset();
      for (let offset = 0; offset < 201; offset += 100) {
        const records = Array.from(
          { length: Math.min(100, 201 - offset) },
          (_, index) => ({
            ...base,
            data: {
              ...measurementFixture("weight"),
              value: 70,
              body_region: `synthetic-region-${offset + index}`,
            },
          }),
        );
        assert.equal((await rest("/v1/measurements", { records })).status, 200);
      }
      const context = await call("health_get_context", {});
      assert.equal((context.latest_measurements as Data[]).length, 200);
      assert.equal(object(context.truncation).has_more, true);
      for (let batch = 0; batch < 8; batch++)
        assert.equal(
          (
            await rest("/v1/measurements", {
              records: Array.from({ length: 100 }, () => examples.measurement),
            })
          ).status,
          200,
        );
      assert.equal((await rest(`/v1/days/${fixtureDate}`)).status, 413);
      assert.equal(
        (await mcpFailure("health_get_daily_summary", { date: fixtureDate }))
          .code,
        "LIMIT_EXCEEDED",
      );
      await reset();
    },
  );
  await check(
    "Legacy payloads, revision snapshots and committed retries stay lossless without fresh validation",
    async () => {
      const created = await save(
        "nutrition",
        examples.nutrition.data,
        "legacy-retry",
      );
      const data = {
        entry_kind: "intake",
        nutrients: { carbohydrate_g: 20, folate_ug: 100, vitamin_k_ug: 10 },
        legacy_source_definition: "Unresolved supplied basis",
      };
      const { time_context: _timeContext, ...oldEnvelope } = created;
      const snapshot = { ...oldEnvelope, schema_version: 1, data };
      await connection!.pool.query(
        "UPDATE health_records SET schema_version=1, payload=$1 WHERE id=$2",
        [data, created.id],
      );
      await connection!.pool.query(
        "UPDATE record_revisions SET snapshot=$1 WHERE record_id=$2 AND version=1",
        [snapshot, created.id],
      );
      await connection!.pool.query(
        "UPDATE idempotency_requests SET request_hash=$1 WHERE operation='health_log_nutrition' AND idempotency_key='legacy-retry'",
        [hash({ ...base, data })],
      );
      const read = await call("health_get_record", {
        id: created.id,
        include_history: true,
      });
      assert.deepEqual(object(read.record).data, data);
      assert.deepEqual((read.history as Data[])[0]!.snapshot, snapshot);
      const replay = await call("health_log_nutrition", {
        ...base,
        data,
        idempotency_key: "legacy-retry",
      });
      assert.equal(replay.idempotent_replay, true);
      assert.deepEqual(replay.record, snapshot);
      const restReplay = await rest(
        "/v1/nutrition",
        { ...base, data },
        "legacy-retry",
      );
      assert.equal(restReplay.status, 200);
      assert.deepEqual(restReplay.body.record, snapshot);
      const replacement = {
        record_type: "nutrition",
        ...base,
        data: { entry_kind: "intake", nutrients: data.nutrients },
      };
      const correction = await call("health_correct_record", {
        id: created.id,
        idempotency_key: "legacy-correction",
        expected_version: 1,
        reason: "Explicit synthetic upgrade",
        replacement,
      });
      assert.equal(object(correction.record).schema_version, 2);
      const history = await call("health_get_record", {
        id: created.id,
        include_history: true,
      });
      assert.deepEqual((history.history as Data[])[1]!.snapshot, snapshot);
      await reset();
    },
  );
  await check(
    "Forward Drizzle migration preserves a populated prior schema and unknown original time context",
    async () => {
      const folder = await mkdtemp(join(tmpdir(), "vitalog-migration-"));
      const url = dbUrl.replace(/\/vitalog$/, "/vitalog_upgrade");
      command([
        "exec",
        container,
        "createdb",
        "-U",
        "vitalog",
        "vitalog_upgrade",
      ]);
      const previous = database(url);
      try {
        const journal = JSON.parse(
          await readFile("drizzle/meta/_journal.json", "utf8"),
        ) as { entries: { tag: string }[] };
        await mkdir(join(folder, "meta"));
        await writeFile(
          join(folder, "meta/_journal.json"),
          JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }),
        );
        await copyFile(
          `drizzle/${journal.entries[0]!.tag}.sql`,
          join(folder, `${journal.entries[0]!.tag}.sql`),
        );
        await migrate(previous.db, { migrationsFolder: folder });
        const id = randomUUID();
        const data = {
          entry_kind: "intake",
          nutrients: { carbohydrate_g: 20, folate_ug: 100, vitamin_k_ug: 10 },
        };
        await previous.pool.query(
          "INSERT INTO health_records (id,record_type,schema_version,version,occurred_on,timezone,time_precision,date_basis,recorded_at,updated_at,status,validity,provenance,payload) VALUES ($1,'nutrition',1,1,$2,'Asia/Kolkata','date','reported_date',now(),now(),'active','valid',$3,$4)",
          [id, fixtureDate, base.provenance, data],
        );
        await migrateDatabase(url);
        const read = await new Service(
          previous.db,
          "synthetic-migration-cursor-key",
        ).execute("health_get_record", { id });
        operations
          .find((operation) => operation.name === "health_get_record")!
          .output.parse(read);
        assert.deepEqual(object(read.record).data, data);
        assert.equal(object(read.record).schema_version, 1);
        assert.equal(object(read.record).occurred_at, null);
        assert.deepEqual(object(read.record).time_context, {
          original_occurred_at: null,
          original_ended_at: null,
          supplied_timezone: null,
        });
      } finally {
        await previous.pool.end();
        await rm(folder, { recursive: true, force: true });
        command([
          "exec",
          container,
          "dropdb",
          "-U",
          "vitalog",
          "vitalog_upgrade",
        ]);
      }
    },
  );
  await check(
    "Linked observations, self-links/cycles, date-changing daily-total conflicts, stable pagination and actionable failures",
    async () => {
      const a = await save("nutrition", {
        entry_kind: "daily_total",
        nutrients: { protein_g: 2 },
      });
      const b = await rest("/v1/nutrition", {
        ...base,
        occurred_on: "2026-09-11",
        data: { entry_kind: "daily_total", nutrients: { protein_g: 3 } },
      });
      assert.equal(b.status, 200);
      const conflict = await rest(`/v1/records/${a.id}/corrections`, {
        expected_version: 1,
        reason: "Synthetic",
        replacement: {
          record_type: "nutrition",
          ...base,
          occurred_on: "2026-09-11",
          data: a.data,
        },
      });
      assert.equal(conflict.status, 409);
      const c = await save("measurement", {
        ...measurementFixture("weight"),
        related_record_ids: [{ record_id: a.id, relationship: "derived_from" }],
      });
      const cycle = await rest(`/v1/records/${a.id}/corrections`, {
        expected_version: 1,
        reason: "Synthetic",
        replacement: {
          record_type: "nutrition",
          ...base,
          data: {
            ...a.data,
            related_record_ids: [
              { record_id: c.id, relationship: "component_of" },
            ],
          },
        },
      });
      assert.equal(cycle.status, 422);
      const pageIds: string[] = [];
      let cursor: unknown;
      do {
        const page = await call("health_list_records", {
          limit: 1,
          ...(cursor ? { cursor } : {}),
        });
        pageIds.push(
          ...(page.records as Data[]).map((record) => String(record.id)),
        );
        cursor = page.next_cursor;
      } while (cursor);
      assert.equal(pageIds.length, 3);
      assert.equal(new Set(pageIds).size, 3);
      for (const transport of ["REST", "MCP"]) {
        const filteredIds: string[] = [];
        let filteredCursor: unknown;
        do {
          const filters = {
            start_date: fixtureDate,
            end_date: fixtureDate,
            limit: 1,
            ...(filteredCursor ? { cursor: filteredCursor } : {}),
          };
          const page =
            transport === "MCP"
              ? await call("health_list_records", filters)
              : (
                  await rest(
                    "/v1/records?" +
                      new URLSearchParams(
                        Object.entries(filters).map(([key, value]) => [
                          key,
                          String(value),
                        ]),
                      ),
                  )
                ).body;
          for (const record of page.records as Data[]) {
            assert.equal(record.occurred_on, fixtureDate);
            filteredIds.push(String(record.id));
          }
          filteredCursor = page.next_cursor;
        } while (filteredCursor);
        assert.deepEqual(new Set(filteredIds), new Set([a.id, c.id]));
        assert.equal(filteredIds.length, 2);
      }
      const bad = {
        idempotency_key: "bad-key",
        ...base,
        data: { entry_kind: "intake", nutrients: { protein: 1 } },
      };
      assert.equal(
        (await mcpFailure("health_log_nutrition", bad)).code,
        "VALIDATION_ERROR",
      );
      const restBad = await rest("/v1/nutrition", { ...base, data: bad.data });
      assert.equal(restBad.status, 422);
      assert(JSON.stringify(restBad.body).includes("protein_g"));
      assert.equal((await rest("/v1/records?query=DROP%20TABLE")).status, 422);
      await reset();
    },
  );
  await check(
    "Real PostgreSQL streaming export, backup/restore and permanent operator erasure cover revisions/idempotency",
    async () => {
      const createKey = randomUUID();
      const createArgs = { ...base, data: examples.nutrition.data };
      const created = await rest("/v1/nutrition", createArgs, createKey);
      assert.equal(created.status, 200);
      const original = object(created.body.record);
      const correctionKey = randomUUID();
      const correctionArgs = {
        expected_version: 1,
        reason: "Corrected source observation for backup verification",
        replacement: {
          record_type: "nutrition",
          ...base,
          data: {
            entry_kind: "intake",
            nutrients: { protein_g: 0, energy_kcal: null },
            nutrient_qualifiers: {
              energy_kcal: { kind: "unquantified", reason: "unknown" },
            },
            notes: "Synthetic revised observation",
          },
        },
      };
      const corrected = await rest(
        `/v1/records/${original.id}/corrections`,
        correctionArgs,
        correctionKey,
      );
      assert.equal(corrected.status, 200);
      const voidKey = randomUUID();
      const voidArgs = {
        expected_version: 2,
        reason: "Synthetic void retained in backup history",
      };
      const voided = await rest(
        `/v1/records/${original.id}/voids`,
        voidArgs,
        voidKey,
      );
      assert.equal(voided.status, 200);
      const originalHistory = await rest(
        `/v1/records/${original.id}?include_history=true`,
      );
      const before = await counts();
      const tableQueries = {
        health_records:
          "SELECT row_to_json(r) AS data FROM health_records r ORDER BY id",
        record_revisions:
          "SELECT row_to_json(r) AS data FROM record_revisions r ORDER BY record_id, version",
        idempotency_requests:
          "SELECT row_to_json(r) AS data FROM idempotency_requests r ORDER BY operation, idempotency_key",
      };
      const tableSnapshot = async (
        pool: ReturnType<typeof database>["pool"],
      ) => {
        const snapshot: Record<string, unknown[]> = {};
        for (const [table, query] of Object.entries(tableQueries))
          snapshot[table] = (await pool.query(query)).rows.map(
            (row) => row.data,
          );
        return snapshot;
      };
      const beforeRows = await tableSnapshot(connection!.pool);
      const exported = execFileSync(
        process.execPath,
        ["--import", "tsx", "scripts/export.ts"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            S3_BUCKET: "",
            S3_ENDPOINT: "",
            S3_ACCESS_KEY_ID: "",
            S3_SECRET_ACCESS_KEY: "",
            DATABASE_URL: dbUrl,
          },
        },
      );
      const rows = exported
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(
        rows.length,
        1 + before.records + before.revisions + before.idempotency,
      );
      assert.equal(rows[0].format, "vitalog-export-jsonl");
      for (const [table, values] of Object.entries(beforeRows))
        assert.deepEqual(
          rows.filter((row) => row.table === table).map((row) => row.data),
          values,
        );
      assert(!exported.includes(key));
      const dump = execFileSync(
        "docker",
        [
          "exec",
          container,
          "pg_dump",
          "-U",
          "vitalog",
          "-d",
          "vitalog",
          "--format=custom",
          "--no-owner",
          "--no-privileges",
        ],
        { maxBuffer: 40 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] },
      );
      command([
        "exec",
        container,
        "createdb",
        "-U",
        "vitalog",
        "vitalog_restore",
      ]);
      command(
        [
          "exec",
          "-i",
          container,
          "pg_restore",
          "-U",
          "vitalog",
          "-d",
          "vitalog_restore",
          "--no-owner",
          "--no-privileges",
          "--exit-on-error",
        ],
        { input: dump },
      );
      const restored = database(
        dbUrl.replace(/\/vitalog$/, "/vitalog_restore"),
      );
      try {
        const result = await restored.pool.query(
          "SELECT (SELECT count(*)::int FROM health_records) records, (SELECT count(*)::int FROM record_revisions) revisions, (SELECT count(*)::int FROM idempotency_requests) idempotency",
        );
        assert.deepEqual(result.rows[0], before);
        assert.deepEqual(await tableSnapshot(restored.pool), beforeRows);
        const restoredService = new Service(restored.db, hash(key));
        const restoredHistory = await restoredService.execute(
          "health_get_record",
          { id: original.id, include_history: true },
        );
        assert.deepEqual(restoredHistory, originalHistory.body);
        for (const [operation, args, committed] of [
          [
            "health_log_nutrition",
            { ...createArgs, idempotency_key: createKey },
            created.body,
          ],
          [
            "health_correct_record",
            {
              ...correctionArgs,
              id: original.id,
              idempotency_key: correctionKey,
            },
            corrected.body,
          ],
          [
            "health_void_record",
            { ...voidArgs, id: original.id, idempotency_key: voidKey },
            voided.body,
          ],
        ] as const) {
          const replay = await restoredService.execute(operation, args);
          assert.equal(replay.idempotent_replay, true);
          assert.deepEqual(replay, { ...committed, idempotent_replay: true });
          operations
            .find((item) => item.name === operation)!
            .output.parse(replay);
        }
        assert.deepEqual(await tableSnapshot(restored.pool), beforeRows);
      } finally {
        await restored.pool.end();
      }
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/erase.ts",
          "--confirm-permanent-erasure=ERASE_VITALOG",
        ],
        {
          env: {
            ...process.env,
            S3_BUCKET: "",
            S3_ENDPOINT: "",
            S3_ACCESS_KEY_ID: "",
            S3_SECRET_ACCESS_KEY: "",
            DATABASE_URL: dbUrl,
          },
          stdio: "pipe",
        },
      );
      assert.deepEqual(await counts(), {
        records: 0,
        revisions: 0,
        idempotency: 0,
      });
      return 22;
    },
  );
  await check(
    "Oversized requests and secret-bearing argument shapes are rejected; logs contain operational metadata only",
    async () => {
      const oversize = await rest("/v1/nutrition", {
        ...base,
        data: {
          entry_kind: "intake",
          nutrients: {},
          notes: "x".repeat(1024 * 1024),
        },
      });
      assert.equal(oversize.status, 413);
      assert.equal(oversize.response.headers.get("Connection"), "close");
      const credentialArgument = await rest(
        "/mcp",
        {
          jsonrpc: "2.0",
          id: "credential-in-argument",
          method: "tools/call",
          params: { name: "health_get_catalog", arguments: { AUTH_KEY: key } },
        },
        randomUUID(),
        {
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": LATEST_PROTOCOL_VERSION,
        },
      );
      assert.equal(credentialArgument.status, 422);
      assert.equal(credentialArgument.body.code, "VALIDATION_ERROR");
      assert.equal(
        (await call("health_get_catalog", {})).catalog_version,
        CATALOG_VERSION,
      );
      assert(!JSON.stringify(credentialArgument.body).includes(key));
      assert(!JSON.stringify(logs).includes(key));
      assert(!JSON.stringify(logs).includes("Lunch"));
      assert(
        logs.every((entry) =>
          Object.keys(entry).every((key) =>
            ["event", "method", "status", "duration_ms"].includes(key),
          ),
        ),
      );
    },
  );
  await check(
    "Rate limits use the socket peer despite forged forwarded addresses",
    async () => {
      const config = configuration({
        AUTH_KEY: key,
        DATABASE_URL: dbUrl,
        RATE_LIMIT_PER_MINUTE: "1",
      });
      const limited = application(
        new Service(connection!.db, config.authDigest.toString("hex")),
        config,
        () => {},
      );
      const limitedServer = serve({
        fetch: limited.fetch,
        port: 0,
        hostname: "127.0.0.1",
      });
      assert(limitedServer instanceof Server);
      try {
        if (!limitedServer.listening) await once(limitedServer, "listening");
        const address = limitedServer.address();
        assert(address && typeof address === "object");
        const url = `http://127.0.0.1:${address.port}/v1/catalog`;
        config.allowedHosts = [`127.0.0.1:${address.port}`];
        const first = await fetch(url, {
          headers: {
            Authorization: `Bearer ${key}`,
            "X-Forwarded-For": "203.0.113.1",
            Forwarded: "for=203.0.113.1",
            "CF-Connecting-IP": "203.0.113.1",
            "X-Real-IP": "203.0.113.1",
          },
        });
        assert.equal(first.status, 200);
        const next = await fetch(url, {
          headers: {
            Authorization: `Bearer ${key}`,
            "X-Forwarded-For": "203.0.113.2",
            Forwarded: "for=203.0.113.2",
            "CF-Connecting-IP": "203.0.113.2",
            "X-Real-IP": "203.0.113.2",
          },
        });
        assert.equal(next.status, 429);
        assert.equal(next.headers.get("Retry-After"), "60");
        assert.equal(object(await next.json()).code, "RATE_LIMITED");
      } finally {
        await new Promise<void>((resolve) =>
          limitedServer.close(() => resolve()),
        );
        limitedServer.closeAllConnections();
      }
    },
  );
  await check(
    "Mood enums round-trip across REST/MCP with discovery, retries, latest selection, correction, void and restart persistence",
    async () => {
      await reset();
      const catalog = await call("health_get_catalog", {
        category: "record_schemas",
        key: "checkin",
        field_path: "/mood",
      });
      assert(JSON.stringify(catalog).includes(JSON.stringify(moodValues)));
      const tools = await client!.listTools();
      assert(
        JSON.stringify(
          tools.tools.find((tool) => tool.name === "health_log_checkin")!
            .inputSchema,
        ).includes(JSON.stringify(moodValues)),
      );
      let latest: HealthRecord | undefined;
      for (const [index, mood] of moodValues.entries()) {
        const restKey = randomUUID();
        const restArgs = {
          occurred_on: fixtureDate,
          timezone: base.timezone,
          provenance: base.provenance,
          occurred_at: `${fixtureDate}T${String(8 + index).padStart(2, "0")}:00:00+05:30`,
          data: { mood, notes: "Synthetic mood check-in" },
        };
        const created = await rest("/v1/checkins", restArgs, restKey);
        assert.equal(created.status, 200, JSON.stringify(created.body));
        const fromRest = created.body.record as HealthRecord;
        assert.equal(fromRest.data.mood, mood);
        const replay = await call("health_log_checkin", {
          ...restArgs,
          idempotency_key: restKey,
        });
        assert.equal(replay.idempotent_replay, true);
        assert.equal((replay.record as HealthRecord).id, fromRest.id);
        const mcpKey = randomUUID();
        const mcpArgs = {
          ...restArgs,
          occurred_at: `${fixtureDate}T${14 + index}:00:00+05:30`,
        };
        const fromMcp = await call("health_log_checkin", {
          ...mcpArgs,
          idempotency_key: mcpKey,
        });
        latest = fromMcp.record as HealthRecord;
        assert.equal(latest.data.mood, mood);
        const replayRest = await rest("/v1/checkins", mcpArgs, mcpKey);
        assert.equal(replayRest.status, 200);
        assert.equal(replayRest.body.idempotent_replay, true);
        assert.equal((replayRest.body.record as HealthRecord).id, latest.id);
      }
      const beforeInvalid = await counts();
      for (const mood of ["happy", "GOOD", 3, null]) {
        const invalid = await rest("/v1/checkins", { ...base, data: { mood } });
        assert.equal(invalid.status, 422);
        assert.equal(invalid.body.code, "VALIDATION_ERROR");
        const invalidMcp = await mcpFailure("health_log_checkin", {
          ...base,
          data: { mood },
          idempotency_key: randomUUID(),
        });
        assert.equal(invalidMcp.code, "VALIDATION_ERROR");
      }
      assert.deepEqual(await counts(), beforeInvalid);
      const restDay = await rest(`/v1/days/${fixtureDate}?sections=checkin`);
      const mcpDay = await call("health_get_daily_summary", {
        date: fixtureDate,
        sections: ["checkin"],
      });
      assert.equal(restDay.status, 200);
      assert.deepEqual(restDay.body, mcpDay);
      assert.equal(object(object(mcpDay.checkin).latest_mood).value, "great");
      assert.equal(
        object(object(mcpDay.checkin).latest_mood).source_id,
        latest!.id,
      );
      assert.equal(
        (object(mcpDay.checkin).observations as HealthRecord[]).length,
        moodValues.length * 2,
      );
      const listed = await call("health_list_records", {
        record_types: ["checkin"],
        start_date: fixtureDate,
        end_date: fixtureDate,
      });
      assert.equal(
        (listed.records as HealthRecord[]).length,
        moodValues.length * 2,
      );
      const corrected = await call("health_correct_record", {
        id: latest!.id,
        idempotency_key: randomUUID(),
        expected_version: 1,
        reason: "Correct synthetic mood",
        replacement: {
          record_type: "checkin",
          occurred_on: fixtureDate,
          occurred_at: latest!.occurred_at,
          timezone: base.timezone,
          provenance: base.provenance,
          data: { mood: "low" },
        },
      });
      assert.equal((corrected.record as HealthRecord).version, 2);
      assert.equal(
        object(
          object(
            (await rest(`/v1/days/${fixtureDate}?sections=checkin`)).body
              .checkin,
          ).latest_mood,
        ).value,
        "low",
      );
      const voided = await rest(`/v1/records/${latest!.id}/voids`, {
        expected_version: 2,
        reason: "Void synthetic check-in",
      });
      assert.equal(voided.status, 200);
      const afterVoid = await call("health_get_daily_summary", {
        date: fixtureDate,
        sections: ["checkin"],
      });
      assert.equal(object(object(afterVoid.checkin).latest_mood).value, "good");
      await stopApi();
      await startApi();
      const afterRestart = await rest(
        `/v1/days/${fixtureDate}?sections=checkin`,
      );
      assert.deepEqual(afterRestart.body, afterVoid);
      const history = await call("health_get_record", {
        id: latest!.id,
        include_history: true,
      });
      assert.equal((history.record as HealthRecord).status, "voided");
      return 63;
    },
  );
  const report = {
    tested_at: new Date().toISOString(),
    node: process.version,
    postgres: postgresVersion,
    mcp_sdk: "@modelcontextprotocol/sdk@1.31.0",
    mcp_protocol_revision: LATEST_PROTOCOL_VERSION,
    transport: "stateless Streamable HTTP with JSON responses",
    client: "official TypeScript MCP Client and StreamableHTTPClientTransport",
    checks,
    definition_coverage: covered,
    coverage_counts: Object.fromEntries(
      Object.entries(covered).map(([key, entries]) => [key, entries.length]),
    ),
    remaining_unsupported_branches: [],
    backup_restore:
      "Streaming export and custom-format pg_dump/pg_restore into a fresh database; all record/revision/idempotency values compared, history retrieved, original create/correction/void retries replayed without new rows",
    data_scope: "Synthetic fixtures in a disposable PostgreSQL container only",
  };
  await mkdir(".test-artifacts", { recursive: true });
  await writeFile(
    ".test-artifacts/verification.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  process.stdout.write(
    `PASS ${checks.length} integration groups; ${covered.nutrients!.length + covered.measurements!.length + covered.lab_analytes!.length} definitions through REST, MCP and corrections\n`,
  );
} finally {
  await stopApi();
  try {
    command(["rm", "--force", container]);
  } catch {
    /* It may already have been removed by --rm. */
  }
}
