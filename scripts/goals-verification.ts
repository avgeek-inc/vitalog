import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { application } from "../src/app.js";
import { configuration } from "../src/config.js";
import { database } from "../src/db/client.js";
import { Service } from "../src/service.js";
import { Goals } from "../src/domain/goals.js";
import { localDate } from "../src/domain/validation.js";
import { object, type Data } from "../src/domain/types.js";
import { operationByName } from "../src/registry/operations.js";
import { goalMetrics } from "../src/registry/goals.js";
import { migrateDatabase } from "./migrate.js";

const container = `vitalog-goals-verification-${process.pid}`;
const password = randomBytes(32).toString("hex");
const key = randomBytes(32).toString("base64url");
const command = (
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string } = {},
) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 40 * 1024 * 1024,
    ...options,
  }).trim();
let connection: ReturnType<typeof database> | undefined;
let server: Server | undefined;
let client: Client | undefined;
let baseUrl = "";
const checks: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  process.stdout.write(`RUN ${name}\n`);
  await fn();
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}
async function rest(path: string, body?: Data, idem: string = randomUUID()) {
  const response = await fetch(baseUrl + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body
        ? { "Content-Type": "application/json", "Idempotency-Key": idem }
        : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: object(await response.json()) };
}
async function call(name: string, input: Data) {
  const response = await client!.callTool({ name, arguments: input });
  assert(!response.isError, JSON.stringify(response.content));
  const result = object(response.structuredContent);
  operationByName.get(name)!.output.parse(result);
  return result;
}
const setOperation = operationByName.get("health_set_goal")!;
const archiveOperation = operationByName.get("health_archive_goal")!;
const progressOperation = operationByName.get("health_get_goal_progress")!;
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
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      command([
        "exec",
        container,
        "pg_isready",
        "-U",
        "vitalog",
        "-d",
        "vitalog",
      ]);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const port = command(["port", container, "5432/tcp"]).split(":").at(-1)!;
  const url = `postgresql://vitalog:${password}@127.0.0.1:${port}/vitalog`;
  await migrateDatabase(url);
  await migrateDatabase(url);
  connection = database(url);
  const config = configuration({
    AUTH_KEY: key,
    DATABASE_URL: url,
    DEFAULT_TIMEZONE: "Asia/Kolkata",
    RATE_LIMIT_PER_MINUTE: "100000",
  });
  const service = new Service(
    connection.db,
    config.timezone,
    "synthetic-goals-verification",
  );
  const instance = serve({
    fetch: application(service, config, () => {}).fetch,
    port: 0,
    hostname: "127.0.0.1",
  });
  assert(instance instanceof Server);
  server = instance;
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  config.allowedHosts = [`127.0.0.1:${address.port}`];
  baseUrl = `http://127.0.0.1:${address.port}`;
  client = new Client({ name: "generic-goal-client", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(baseUrl + "/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    }),
  );
  const today = localDate(new Date(), config.timezone);
  let weightId = "";
  await check(
    "Fresh migrations, readiness and authenticated REST/MCP goal catalog",
    async () => {
      assert.equal((await rest("/readyz")).status, 200);
      const catalog = await rest("/v1/goals/catalog");
      assert.deepEqual(catalog.body, await call("health_get_goal_catalog", {}));
      assert.equal((catalog.body.metrics as Data[]).length, goalMetrics.length);
      assert.deepEqual((await rest("/v1/goals")).body.goals, []);
      assert.equal((await fetch(baseUrl + "/v1/goals")).status, 401);
      assert.equal(
        (
          await rest("/v1/goals", {
            metric: "measurement:weight",
            target: 70,
            expected_version: 0,
          })
        ).status,
        422,
      );
    },
  );
  await check(
    "Local-day goal revisions preserve previous targets across edits, archival and reactivation",
    async () => {
      let clock = new Date("2026-09-10T18:00:00Z");
      const historic = new Goals(connection!.db, config.timezone, () => clock);
      const input = {
        metric: "measurement:weight",
        target: 70,
        baseline: 80,
        expected_version: 0,
        idempotency_key: "historic-weight",
      };
      const original = await historic.execute(setOperation, input);
      weightId = String(object(original.goal).id);
      assert.equal(object(original.goal).effective_on, "2026-09-10");
      clock = new Date("2026-09-10T18:40:00Z");
      await historic.execute(setOperation, {
        metric: "measurement:weight",
        target: 68,
        expected_version: 1,
        idempotency_key: "historic-weight-edit",
      });
      clock = new Date("2026-09-12T01:00:00Z");
      await historic.execute(archiveOperation, {
        id: weightId,
        expected_version: 2,
        idempotency_key: "historic-weight-archive",
      });
      for (const [date, target] of [
        ["2026-09-10", 70],
        ["2026-09-11", 68],
      ] as const)
        assert.equal(
          object(
            (
              (await historic.execute(progressOperation, { date }))
                .progress as Data[]
            )[0]!.goal,
          ).target,
          target,
        );
      assert.deepEqual(
        (await historic.execute(progressOperation, { date: "2026-09-12" }))
          .progress,
        [],
      );
      assert.deepEqual(
        (await historic.execute(setOperation, input)).goal,
        original.goal,
      );
      const history = await rest(
        `/v1/goals/${weightId}?include_history=true&history_limit=2`,
      );
      assert.equal((history.body.history as Data[]).length, 2);
      assert.equal(history.body.history_has_more, true);
      const next = await rest(
        `/v1/goals/${weightId}?include_history=true&history_before_version=${history.body.history_next_version}`,
      );
      assert.deepEqual(
        (next.body.history as Data[]).map((row) => row.version),
        [1],
      );
      assert.equal(
        (
          await rest("/v1/goals", {
            metric: "measurement:weight",
            target: 65,
            expected_version: 3,
          })
        ).status,
        200,
      );
    },
  );
  const targets: Record<string, number> = {
    "measurement:weight": 65,
    "nutrient:energy_kcal": 2000,
    "nutrient:protein_g": 120,
    "nutrient:carbohydrate_g": 220,
    "nutrient:fat_g": 70,
    "nutrient:fiber_g": 30,
    "hydration:water_ml": 2500,
    "activity:active_energy_kcal": 400,
    "activity:exercise_minutes": 60,
  };
  let waterId = "";
  let waterOriginal: Data | undefined;
  const waterKey = "water-creation-retry";
  await check(
    "All supported goal metrics round-trip through both transports with shared schemas",
    async () => {
      for (const definition of goalMetrics) {
        if (definition.metric === "measurement:weight") continue;
        const input = {
          metric: definition.metric,
          target: targets[definition.metric]!,
          expected_version: 0,
          idempotency_key:
            definition.metric === "hydration:water_ml"
              ? waterKey
              : randomUUID(),
        };
        const saved = await call("health_set_goal", input);
        const goal = object(saved.goal);
        assert.deepEqual((await rest(`/v1/goals/${goal.id}`)).body.goal, goal);
        if (definition.metric === "hydration:water_ml") {
          waterId = String(goal.id);
          waterOriginal = saved;
        }
      }
      const listed = await call("health_list_goals", {});
      assert.equal(listed.returned_count, goalMetrics.length);
      assert.deepEqual(listed, (await rest("/v1/goals")).body);
      const tools = (await client!.listTools()).tools;
      for (const name of ["health_set_goal", "health_archive_goal"]) {
        assert.equal(
          tools.find((tool) => tool.name === name)!.annotations?.readOnlyHint,
          false,
        );
        assert.equal(
          tools.find((tool) => tool.name === name)!.annotations
            ?.destructiveHint,
          true,
        );
      }
      for (const extra of [
        { direction: "maximum" },
        { unit: "g" },
        { baseline: 1 },
      ])
        assert.equal(
          (
            await rest("/v1/goals", {
              metric: "hydration:water_ml",
              target: 2500,
              expected_version: 1,
              ...extra,
            })
          ).status,
          422,
        );
    },
  );
  await check(
    "Concurrent edits have one winner; committed retries preserve the original snapshot",
    async () => {
      const edits = await Promise.all(
        [2600, 2700].map((target) =>
          rest("/v1/goals", {
            metric: "hydration:water_ml",
            target,
            expected_version: 1,
          }),
        ),
      );
      assert.deepEqual(
        edits.map((response) => response.status).sort(),
        [200, 409],
      );
      const replay = await rest(
        "/v1/goals",
        { metric: "hydration:water_ml", target: 2500, expected_version: 0 },
        waterKey,
      );
      assert.equal(replay.status, 200);
      assert.deepEqual(replay.body.goal, waterOriginal!.goal);
      assert.equal(replay.body.idempotent_replay, true);
      assert.equal(
        (
          await rest(
            "/v1/goals",
            { metric: "hydration:water_ml", target: 2400, expected_version: 0 },
            waterKey,
          )
        ).status,
        409,
      );
      const archived = await call("health_archive_goal", {
        id: waterId,
        expected_version: 2,
        idempotency_key: "archive-water",
      });
      const replayArchive = await rest(
        `/v1/goals/${waterId}/archive`,
        { expected_version: 2 },
        "archive-water",
      );
      assert.deepEqual(replayArchive.body.goal, archived.goal);
      assert.equal(replayArchive.body.idempotent_replay, true);
      assert.equal(
        (await call("health_list_goals", {})).returned_count,
        goalMetrics.length - 1,
      );
      assert.equal(
        (
          await rest("/v1/goals", {
            metric: "hydration:water_ml",
            target: 2500,
            expected_version: 3,
          })
        ).status,
        200,
      );
    },
  );
  await check(
    "Progress combines observed records, excludes future weights and uses explicit active minutes",
    async () => {
      const envelope = {
        occurred_on: today,
        timezone: config.timezone,
        provenance: { source_type: "manual", value_kind: "reported" },
      };
      for (const [path, data] of [
        [
          "/v1/nutrition",
          {
            entry_kind: "intake",
            nutrients: {
              energy_kcal: 1500,
              protein_g: 90,
              carbohydrate_g: 150,
              fat_g: 40,
              fiber_g: 18,
            },
          },
        ],
        [
          "/v1/hydration",
          { entry_kind: "intake", volume_ml: 1250, drink_type: "water" },
        ],
        [
          "/v1/activities",
          {
            entry_kind: "workout",
            activity_type: "walking",
            elapsed_seconds: 3600,
            exercise_seconds: 2700,
            energy_kcal: 280,
            energy_basis: "active",
          },
        ],
      ] as const)
        assert.equal((await rest(path, { ...envelope, data })).status, 200);
      assert.equal(
        (
          await rest("/v1/measurements", {
            records: [
              {
                ...envelope,
                data: {
                  kind: "scalar",
                  metric_key: "weight",
                  value: 75,
                  unit: "kg",
                },
              },
            ],
          })
        ).status,
        200,
      );
      const response = await call("health_get_goal_progress", { date: today });
      assert.deepEqual(
        response,
        (await rest(`/v1/days/${today}/goal-progress`)).body,
      );
      const rows = response.progress as Data[];
      const byMetric = (metric: string) =>
        rows.find((row) => object(row.goal).metric === metric)!;
      assert.equal(byMetric("nutrient:energy_kcal").progress_percent, 75);
      assert.equal(byMetric("nutrient:fiber_g").actual, 18);
      assert.equal(byMetric("nutrient:fiber_g").progress_percent, 60);
      assert.equal(byMetric("hydration:water_ml").progress_percent, 50);
      assert.equal(
        byMetric("activity:active_energy_kcal").progress_percent,
        70,
      );
      assert.equal(byMetric("activity:exercise_minutes").actual, 45);
      assert.equal(byMetric("measurement:weight").progress_percent, 33.33);
      assert.deepEqual(
        (await rest("/v1/days/2026-09-09/goal-progress")).body.progress,
        [],
      );
      const missing = (await rest("/v1/days/2026-09-10/goal-progress")).body
        .progress as Data[];
      assert.equal(missing[0]!.actual, null);
    },
  );
  await check(
    "Progress bounds apply only to goal-relevant record types",
    async () => {
      const insert = async (date: string) =>
        connection!.pool.query(
          `
      insert into health_records (id, record_type, schema_version, version, occurred_on, timezone, time_precision, date_basis, recorded_at, updated_at, status, validity, provenance, payload)
      select gen_random_uuid(), 'nutrition', 2, 1, $1::date, 'Asia/Kolkata', 'date', 'reported_date', now(), now(), 'active', 'valid', '{"source_type":"manual","value_kind":"reported"}'::jsonb, '{"entry_kind":"intake","label":"Synthetic bounds","nutrients":{"protein_g":1}}'::jsonb
      from generate_series(1,1001)
    `,
          [date],
        );
      await insert("2026-09-10");
      const weightOnly = await rest("/v1/days/2026-09-10/goal-progress");
      assert.equal(weightOnly.status, 200);
      assert.equal((weightOnly.body.progress as Data[]).length, 1);
      await insert(today);
      assert.equal((await rest(`/v1/days/${today}/goal-progress`)).status, 413);
      await connection!.pool.query(
        "delete from health_records where payload->>'label' = 'Synthetic bounds'",
      );
    },
  );
  await check(
    "Persistence, goal export and backup/restore retain revisions and retry results",
    async () => {
      const before = await service.execute("health_list_goals", {
        status: "all",
      });
      assert.deepEqual(
        await new Service(connection!.db, config.timezone, "restart").execute(
          "health_list_goals",
          { status: "all" },
        ),
        before,
      );
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
            DATABASE_URL: url,
          },
        },
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const tables = ["goals", "goal_revisions", "goal_idempotency_requests"];
      for (const table of tables)
        assert(exported.some((row) => row.table === table));
      const dump = command([
        "exec",
        container,
        "pg_dump",
        "-U",
        "vitalog",
        "-d",
        "vitalog",
        "--no-owner",
        "--no-privileges",
      ]);
      command(["exec", container, "createdb", "-U", "vitalog", "restored"]);
      command(
        [
          "exec",
          "-i",
          container,
          "psql",
          "-U",
          "vitalog",
          "-d",
          "restored",
          "-v",
          "ON_ERROR_STOP=1",
        ],
        { input: dump },
      );
      const restored = database(url.replace(/\/vitalog$/, "/restored"));
      try {
        const restoredService = new Service(
          restored.db,
          config.timezone,
          "restored",
        );
        assert.deepEqual(
          await restoredService.execute("health_list_goals", { status: "all" }),
          before,
        );
        const replay = await restoredService.execute("health_set_goal", {
          metric: "hydration:water_ml",
          target: 2500,
          expected_version: 0,
          idempotency_key: waterKey,
        });
        assert.deepEqual(replay.goal, waterOriginal!.goal);
        assert.equal(replay.idempotent_replay, true);
        assert.equal(await restoredService.ready(), true);
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
              DATABASE_URL: url.replace(/\/vitalog$/, "/restored"),
            },
            stdio: "pipe",
          },
        );
        for (const table of tables)
          assert.equal(
            Number(
              (await restored.pool.query(`SELECT count(*) FROM ${table}`))
                .rows[0].count,
            ),
            0,
          );
      } finally {
        await restored.pool.end();
      }
    },
  );
  await mkdir(".test-artifacts", { recursive: true });
  await writeFile(
    ".test-artifacts/goals-verification.json",
    JSON.stringify(
      { passed: true, executed_at: new Date().toISOString(), checks },
      null,
      2,
    ) + "\n",
  );
} finally {
  await client?.close();
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  await connection?.pool.end();
  try {
    command(["rm", "--force", container]);
  } catch {
    /* The disposable container may have exited already. */
  }
}
