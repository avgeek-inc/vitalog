import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { Server } from "node:http";
import { createServer } from "node:net";
import { serve } from "@hono/node-server";
import { chromium, type Browser } from "playwright";
import { application } from "../src/app.js";
import { configuration } from "../src/config.js";
import { database } from "../src/db/client.js";
import { Service } from "../src/service.js";
import { localDate } from "../src/domain/validation.js";
import { object, type Data } from "../src/domain/types.js";
import { examples } from "../tests/fixtures.js";
import { keyManagementCreated } from "../src/auth/key-management-contracts.js";
import { OAuthStore, pkceChallenge } from "../src/auth/oauth-store.js";
import { sessionCreated, sessionInfo } from "../src/auth/session-contracts.js";
import { dateLabel, dateOffset } from "../apps/web/src/lib/health.js";
import { operations } from "../src/registry/operations.js";
import { migrateDatabase } from "./migrate.js";

const preview = process.argv.includes("--preview");
const container = `vitalog-web-${process.pid}`;
const databasePassword = randomBytes(32).toString("hex");
const primary = randomBytes(32).toString("base64url");
const credentials = {
  email: "root@example.test",
  password: randomBytes(32).toString("base64url"),
};
const docker = (args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
const checks: string[] = [];
const requestLogs: Data[] = [];
let connection: ReturnType<typeof database> | undefined;
let server: Server | undefined;
let web: ChildProcess | undefined;
let browser: Browser | undefined;
let webLog = "";
let healthReadGate: Promise<void> | undefined;
let apiUrl = "",
  uiUrl = "";
const today = localDate(new Date(), "Asia/Kolkata");
const yesterday = dateOffset(today, -1);
const logTime = (date: string, time: string) => {
  const supplied = new Date(`${date}T${time}:00+05:30`).getTime();
  if (date !== today) return new Date(supplied).toISOString();
  const midnight = new Date(`${date}T00:00:00+05:30`).getTime();
  const fraction = (supplied - midnight) / 86400000;
  return new Date(
    midnight + Math.max(0, Date.now() - midnight - 1000) * fraction,
  ).toISOString();
};
async function port() {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  assert(address && typeof address === "object");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}
async function stopApi() {
  if (!server) return;
  const running = server;
  server = undefined;
  await new Promise<void>((resolve) => {
    running.close(() => resolve());
    running.closeAllConnections();
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
}
async function startApi(rootEnabled = true) {
  await stopApi();
  const config = configuration({
    AUTH_KEY: primary,
    DATABASE_URL: connection!.pool.options.connectionString,
    ...(rootEnabled
      ? { ROOT_EMAIL: credentials.email, ROOT_PASSWORD: credentials.password }
      : {}),
    ALLOWED_HOSTS: new URL(apiUrl).host,
    PUBLIC_BASE_URL: apiUrl,
    UI_BASE_URL: uiUrl,
    RATE_LIMIT_PER_MINUTE: "100000",
  });
  const service = new Service(
    connection!.db,
    config.timezone,
    config.authDigest.toString("hex"),
  );
  const app = application(service, config, (entry) => requestLogs.push(entry));
  const instance = serve({
    fetch: async (request) => {
      if (new URL(request.url).pathname === "/oauth-browser-callback")
        return new Response("MCP client callback received", {
          headers: {
            "Content-Type": "text/plain",
            "Cache-Control": "no-store",
          },
        });
      if (new URL(request.url).pathname.startsWith("/v1/"))
        await healthReadGate;
      return app.fetch(request);
    },
    port: Number(new URL(apiUrl).port),
    hostname: "127.0.0.1",
  });
  assert(instance instanceof Server);
  server = instance;
  if (!instance.listening) await once(instance, "listening");
  return service;
}
async function api(
  path: string,
  token?: string,
  method = "GET",
  body?: unknown,
  extra: Record<string, string> = {},
) {
  const response = await fetch(apiUrl + path, {
    method,
    headers: {
      Connection: "close",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    data: object(JSON.parse(text)),
    text,
    response,
  };
}
async function check(name: string, run: () => Promise<void>) {
  try {
    await run();
  } catch (error) {
    process.stderr.write(`FAIL ${name}: ${String(error)}\n`);
    const page = browser?.contexts()[0]?.pages()[0];
    if (page)
      await page.screenshot({
        path: ".test-artifacts/web/failure.png",
        mask: [
          page.locator(
            'input[type="password"], input[name="api-key"], textarea[name="api-key"]',
          ),
        ],
      });
    throw error;
  }
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}
async function seed(service: Service) {
  let sequence = 0;
  const save = (name: string, date: string, time: string, data: Data) =>
    service.execute(name, {
      idempotency_key: `web-fixture-${++sequence}`,
      occurred_on: date,
      ...(data.entry_kind === "daily_total"
        ? {}
        : { occurred_at: logTime(date, time) }),
      timezone: "Asia/Kolkata",
      time_precision: data.entry_kind === "daily_total" ? "date" : "instant",
      provenance: { source_type: "manual", value_kind: "reported" },
      data,
    });
  for (const [time, label, energy, protein, carbs, fat, fiber] of [
    ["08:00", "Breakfast", 380, 26, 40, 12, 5],
    ["13:00", "Lunch", 620, 40, 68, 22, 8],
    ["19:00", "Dinner", 460, 36, 50, 16, 5],
  ] as const)
    await save("health_log_nutrition", today, time, {
      entry_kind: "intake",
      label,
      nutrients: {
        energy_kcal: energy,
        protein_g: protein,
        carbohydrate_g: carbs,
        fat_g: fat,
        fiber_g: fiber,
      },
    });
  for (const [time, amount] of [
    ["07:00", 250],
    ["10:00", 350],
    ["14:00", 500],
    ["18:00", 250],
  ] as const)
    await save("health_log_hydration", today, time, {
      entry_kind: "intake",
      volume_ml: amount,
      drink_type: "water",
    });
  await save("health_log_activity", today, "17:00", {
    entry_kind: "workout",
    activity_type: "walking",
    energy_kcal: 280,
    energy_basis: "active",
    exercise_seconds: 2700,
    elapsed_seconds: 3000,
  });
  await save("health_log_checkin", today, "20:00", { mood: "good" });
  await save("health_log_sleep", today, "06:30", {
    entry_kind: "session",
    session_type: "main",
    sleep_seconds: 25200,
  });
  for (const [offset, value] of [
    [-25, "78"],
    [-20, "77.2"],
    [-15, "76.4"],
    [-10, "75.5"],
    [-5, "74.8"],
    [-2, "74.1"],
    [0, "73.8"],
  ] as const) {
    const date = dateOffset(today, offset);
    await service.execute("health_log_measurements", {
      idempotency_key: `web-weight-${offset}`,
      records: [
        {
          occurred_on: date,
          occurred_at: logTime(date, "07:30"),
          timezone: "Asia/Kolkata",
          time_precision: "instant",
          provenance: { source_type: "manual", value_kind: "measured" },
          data: { kind: "scalar", metric_key: "weight", value, unit: "kg" },
        },
      ],
    });
  }
  await save("health_log_hydration", yesterday, "10:00", {
    entry_kind: "daily_total",
    water_ml: 0,
  });
  await save("health_log_activity", yesterday, "18:00", {
    entry_kind: "daily_total",
    daily_totals: { active_energy_kcal: 0, exercise_seconds: 0 },
  });
  await save("health_log_checkin", yesterday, "20:00", {
    ratings: {
      mood: {
        value: 8,
        lower: 0,
        upper: 10,
        scale: "custom",
        meaning: "User supplied",
      },
    },
  });
  for (const [metric, target, baseline] of [
    ["measurement:weight", 70, 78],
    ["nutrient:energy_kcal", 1800],
    ["nutrient:protein_g", 120],
    ["nutrient:carbohydrate_g", 200],
    ["nutrient:fat_g", 65],
    ["nutrient:fiber_g", 25],
    ["hydration:water_ml", 2500],
    ["activity:active_energy_kcal", 350],
    ["activity:exercise_minutes", 60],
  ] as const)
    await service.execute("health_set_goal", {
      metric,
      target,
      ...(baseline ? { baseline } : {}),
      expected_version: 0,
      idempotency_key: `web-goal-${metric}`,
    });
  if (!preview)
    for (let index = 0; index < 206; index++)
      await save("health_log_hydration", dateOffset(today, -45), "10:00", {
        entry_kind: "intake",
        volume_ml: 1,
        drink_type: "water",
      });
}
try {
  docker([
    "run",
    "-d",
    "--name",
    container,
    "-e",
    "POSTGRES_PASSWORD=" + databasePassword,
    "-e",
    "POSTGRES_DB=vitalog",
    "-p",
    "127.0.0.1::5432",
    "postgres:17.11-alpine",
  ]);
  const dbPort = docker(["port", container, "5432/tcp"]).split(":").at(-1)!;
  connection = database(
    `postgresql://postgres:${databasePassword}@127.0.0.1:${dbPort}/vitalog`,
  );
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await connection.pool.query("select 1");
      break;
    } catch {
      if (attempt === 59) throw new Error("PostgreSQL did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  await migrateDatabase(connection.pool.options.connectionString!);
  apiUrl = `http://127.0.0.1:${await port()}`;
  uiUrl = `http://127.0.0.1:${await port()}`;
  const service = await startApi();
  await seed(service);
  if (!preview) {
    await check(
      "Read-only sessions expire in 30 days and store only hashes",
      async () => {
        const created = await api(
          "/auth/session",
          undefined,
          "POST",
          credentials,
          { Origin: uiUrl },
        );
        assert.equal(created.status, 201);
        const session = sessionCreated.parse(created.data);
        const stored = (
          await connection!.pool.query(
            "select * from api_keys where token_digest=$1",
            [createHash("sha256").update(session.session_token).digest("hex")],
          )
        ).rows[0];
        assert.equal(
          Date.parse(stored.expires_at) - Date.parse(stored.created_at),
          30 * 86400000,
        );
        assert(!JSON.stringify(stored).includes(session.session_token));
        const info = await api("/auth/session", session.session_token);
        assert.equal(info.status, 200);
        sessionInfo.parse(info.data);
        for (const path of [
          `/v1/days/${today}`,
          `/v1/days/${today}/goal-progress`,
          "/v1/records?limit=200",
          "/v1/goals",
          "/v1/context?sections=measurement",
        ])
          assert.equal((await api(path, session.session_token)).status, 200);
        const count = (
          await connection!.pool.query("select count(*) from health_records")
        ).rows[0].count;
        for (const operation of operations.filter(
          (operation) => operation.mutation,
        )) {
          const path = operation.path.replace(/\{[^}]+\}/g, stored.id);
          assert.equal(
            (
              await api(
                path,
                session.session_token,
                "POST",
                {},
                { "Idempotency-Key": "browser-denied" },
              )
            ).status,
            403,
          );
        }
        assert.equal(
          (await connection!.pool.query("select count(*) from health_records"))
            .rows[0].count,
          count,
        );
        for (const path of ["/v1/api-keys", "/v1/api-keys/" + stored.id])
          assert.equal((await api(path, session.session_token)).status, 403);
        for (const path of ["/mcp", "/readyz", "/openapi.json"])
          assert.equal((await api(path, session.session_token)).status, 401);
        assert.equal((await api("/auth/session", primary)).status, 401);
        assert.equal(
          (await api("/auth/session", session.session_token, "DELETE")).status,
          200,
        );
        assert.equal(
          (await api("/v1/goals", session.session_token)).status,
          401,
        );
      },
    );
    await check(
      "Session sign-in rejects foreign origins, malformed bodies and wrong credentials",
      async () => {
        assert.equal(
          (
            await api("/auth/session", undefined, "POST", credentials, {
              Origin: "https://foreign.example",
            })
          ).status,
          403,
        );
        assert.equal(
          (await api("/auth/session?token=1", undefined, "POST", credentials))
            .status,
          422,
        );
        assert.equal(
          (
            await api("/auth/session", undefined, "POST", {
              ...credentials,
              name: "invalid",
            })
          ).status,
          422,
        );
        const denied = await api("/auth/session", undefined, "POST", {
          ...credentials,
          password: "incorrect-password",
        });
        assert.equal(denied.status, 401);
        assert(!denied.text.includes(credentials.password));
      },
    );
    await startApi();
    await check(
      "Session expiry, restart, revoke-all and credential privacy use the persisted token state",
      async () => {
        const created = sessionCreated.parse(
          (await api("/auth/session", undefined, "POST", credentials)).data,
        );
        await startApi();
        assert.equal(
          (await api("/auth/session", created.session_token)).status,
          200,
        );
        assert.equal(
          (await api("/v1/catalog?query=" + created.session_token, primary))
            .status,
          422,
        );
        const poisoned = {
          ...examples.hydration,
          data: { ...examples.hydration.data, notes: created.session_token },
        };
        assert.equal(
          (
            await api("/v1/hydration", primary, "POST", poisoned, {
              "Idempotency-Key": "session-privacy",
            })
          ).status,
          422,
        );
        const digest = createHash("sha256")
          .update(created.session_token)
          .digest("hex");
        await connection!.pool.query(
          "update api_keys set created_at=created_at - interval '31 days', expires_at=expires_at - interval '31 days' where token_digest=$1",
          [digest],
        );
        await connection!.pool.query(
          "update oauth_access_tokens set created_at=created_at - interval '31 days', expires_at=expires_at - interval '31 days' where token_digest=$1",
          [digest],
        );
        assert.equal(
          (await api("/auth/session", created.session_token)).status,
          401,
        );
        const second = sessionCreated.parse(
          (await api("/auth/session", undefined, "POST", credentials)).data,
        );
        assert.equal(
          (await api("/v1/api-keys", primary, "DELETE")).status,
          200,
        );
        assert.equal(
          (await api("/auth/session", second.session_token)).status,
          401,
        );
        assert.equal((await api("/v1/goals", primary)).status, 200);
      },
    );
    await startApi();
    await check(
      "Key management sessions isolate privileges, hide revoked keys before pagination, and revoke MCP access",
      async () => {
        const management = keyManagementCreated.parse(
          (
            await api(
              "/auth/key-management/session",
              undefined,
              "POST",
              credentials,
            )
          ).data,
        );
        const token = management.session_token;
        assert(
          Math.abs(
            Date.parse(management.expires_at) - Date.now() - 30 * 60_000,
          ) < 3000,
        );
        const digest = createHash("sha256").update(token).digest("hex");
        const stored = (
          await connection!.pool.query(
            "select k.id, k.token_digest, t.resource, t.scopes from api_keys k join oauth_access_tokens t on t.api_key_id=k.id where k.token_digest=$1",
            [digest],
          )
        ).rows[0];
        assert.equal(stored.resource, "urn:vitalog:key-management");
        assert.deepEqual(stored.scopes, ["keys:manage"]);
        assert(!JSON.stringify(stored).includes(token));
        await assert.rejects(
          connection!.pool.query(
            "update oauth_access_tokens set resource=$1 where token_digest=$2",
            [apiUrl + "/mcp", digest],
          ),
          /oauth_token_scopes/,
        );
        const listedSession = (
          (await api("/v1/api-keys", primary)).data.api_keys as Data[]
        ).find((key) => key.id === stored.id);
        assert.equal(listedSession?.expires_at, management.expires_at);
        const browser = sessionCreated.parse(
          (await api("/auth/session", undefined, "POST", credentials)).data,
        );
        for (const path of [
          "/v1/goals",
          "/v1/api-keys",
          "/auth/session",
          "/mcp",
          "/readyz",
          "/openapi.json",
        ])
          assert.equal((await api(path, token)).status, 401, path);
        assert.equal(
          (await api("/auth/key-management/api-keys", browser.session_token))
            .status,
          200,
        );
        for (const method of ["POST", "DELETE"])
          assert.equal(
            (
              await api(
                "/auth/key-management/api-keys",
                browser.session_token,
                method,
              )
            ).status,
            401,
          );
        for (const wrong of [primary])
          assert.equal(
            (await api("/auth/key-management/api-keys", wrong)).status,
            401,
          );
        assert.equal(
          (
            await api("/v1/hydration", token, "POST", examples.hydration, {
              "Idempotency-Key": "management-no-health-write",
            })
          ).status,
          401,
        );
        assert.equal(
          (await api("/auth/key-management/api-keys", token, "POST", {}))
            .status,
          422,
        );
        const created = await api(
          "/auth/key-management/api-keys",
          token,
          "POST",
        );
        assert.equal(created.status, 201);
        const key = object(created.data);
        assert.equal(
          Date.parse(String(key.expires_at)) -
            Date.parse(String(key.created_at)),
          30 * 86400000,
        );
        assert.equal((await api("/v1/goals", String(key.api_key))).status, 200);
        assert.equal(
          (await api("/auth/key-management/api-keys", String(key.api_key)))
            .status,
          401,
        );
        const store = new OAuthStore(connection!.db, apiUrl + "/mcp");
        const verifier = randomBytes(32).toString("base64url");
        const grant = {
          client_id: "https://client.example.test",
          redirect_uri: "https://client.example.test/callback",
          resource: apiUrl + "/mcp",
          scopes: ["health:read"],
          code_challenge: pkceChallenge(verifier),
        };
        const code = await store.issueCode(undefined, grant);
        const oauth = await store.exchange({
          ...grant,
          code,
          code_verifier: verifier,
        });
        assert(
          oauth && (await store.authenticate("Bearer " + oauth.access_token)),
        );
        const list = await api(
          "/auth/key-management/api-keys?limit=1&offset=0",
          token,
        );
        assert.equal(list.status, 200);
        assert.equal(list.data.total, 2);
        assert.equal((list.data.api_keys as Data[]).length, 1);
        assert(!list.text.includes(token));
        assert(!list.text.includes(String(key.api_key)));
        assert.equal(
          (
            await api(
              "/auth/key-management/api-keys/" + stored.id,
              token,
              "DELETE",
            )
          ).status,
          404,
        );
        assert.equal(
          (
            await api(
              "/auth/key-management/api-keys/" + key.id,
              token,
              "DELETE",
            )
          ).status,
          200,
        );
        assert.equal((await api("/v1/goals", String(key.api_key))).status, 401);
        const filtered = await api(
          "/auth/key-management/api-keys?limit=1&offset=0",
          token,
        );
        assert.equal(filtered.data.total, 1);
        assert.equal((filtered.data.api_keys as Data[]).length, 1);
        assert(
          String((filtered.data.api_keys as Data[])[0]!.token_hint).startsWith(
            "vlo_",
          ),
        );
        assert.equal(
          (await api("/auth/key-management/api-keys", token, "DELETE")).status,
          200,
        );
        assert.equal(
          await store.authenticate("Bearer " + oauth.access_token),
          undefined,
        );
        assert.equal(
          (await api("/auth/session", browser.session_token)).status,
          200,
        );
        assert.equal(
          (await api("/auth/key-management/session", token)).status,
          200,
        );
        assert.equal(
          (await api("/v1/catalog?query=" + token, primary)).status,
          422,
        );
        await startApi();
        assert.equal(
          (await api("/auth/key-management/session", token)).status,
          200,
        );
        await connection!.pool.query(
          "update oauth_access_tokens set created_at=created_at - interval '31 minutes', expires_at=expires_at - interval '31 minutes' where token_digest=$1",
          [digest],
        );
        await connection!.pool.query(
          "update api_keys set created_at=created_at - interval '31 minutes', expires_at=expires_at - interval '31 minutes' where token_digest=$1",
          [digest],
        );
        assert.equal(
          (await api("/auth/key-management/api-keys", token)).status,
          401,
        );
        assert.equal(
          ((await api("/v1/api-keys", primary)).data.api_keys as Data[]).find(
            (key) => key.id === stored.id,
          )?.status,
          "expired",
        );
        await connection!.pool.query(
          "delete from oauth_access_tokens where token_digest=$1",
          [digest],
        );
        assert.equal(
          ((await api("/v1/api-keys", primary)).data.api_keys as Data[]).find(
            (key) => key.id === stored.id,
          )?.status,
          "expired",
        );
        const fresh = keyManagementCreated.parse(
          (
            await api(
              "/auth/key-management/session",
              undefined,
              "POST",
              credentials,
            )
          ).data,
        );
        assert.equal(
          (
            await api(
              "/auth/key-management/session",
              fresh.session_token,
              "DELETE",
            )
          ).status,
          200,
        );
        assert.equal(
          (await api("/auth/key-management/api-keys", fresh.session_token))
            .status,
          401,
        );
        await startApi();
      },
    );
  }
  web = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "start",
      "apps/web",
      "--hostname",
      "127.0.0.1",
      "--port",
      new URL(uiUrl).port,
    ],
    {
      env: {
        ...process.env,
        API_BASE_URL: apiUrl,
        UI_BASE_URL: uiUrl,
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  web.stdout?.on("data", (data: Buffer) => {
    webLog += data.toString();
  });
  web.stderr?.on("data", (data: Buffer) => {
    webLog += data.toString();
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(uiUrl + "/healthz")).ok) break;
    } catch {
      /* Server is starting. */
    }
    if (web.exitCode !== null || attempt === 99)
      throw new Error("UI did not become ready: " + webLog.slice(-1000));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await mkdir(".test-artifacts/web", { recursive: true });
  if (preview) {
    await writeFile(
      ".test-artifacts/web/preview.json",
      JSON.stringify({ apiUrl, uiUrl, credentials, today }),
      { mode: 0o600 },
    );
    process.stdout.write(`PREVIEW ${uiUrl}\n`);
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  } else {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
        : {}),
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 1000 },
      colorScheme: "light",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const failures: string[] = [];
    page.on("pageerror", (error) =>
      failures.push(`${page.url()}: ${error.message}`),
    );
    await check(
      "Shared API-key authentication validates credentials and reveals a nameless 30-day key only once",
      async () => {
        await page.goto(uiUrl + "/api-keys");
        await page
          .getByRole("heading", { name: "Generate an API key", exact: true })
          .waitFor();
        assert.equal(await page.getByLabel("Name", { exact: true }).count(), 0);
        await page.getByLabel("Email", { exact: true }).fill(credentials.email);
        await page
          .getByLabel("Password", { exact: true })
          .fill("incorrect-password");
        await page
          .getByRole("button", { name: "Generate API key", exact: true })
          .click();
        await page.getByText("Invalid credentials", { exact: true }).waitFor();
        assert.equal(
          await page.getByLabel("Password", { exact: true }).inputValue(),
          "",
        );
        await page
          .getByLabel("Password", { exact: true })
          .fill(credentials.password);
        const issuance = page.waitForResponse(
          (response) =>
            response.url() === apiUrl + "/auth/api-keys" &&
            response.request().method() === "POST",
        );
        await page
          .getByRole("button", { name: "Generate API key", exact: true })
          .click();
        const issued = await issuance;
        assert.equal(issued.status(), 201);
        const metadata = await issued.json();
        await page
          .getByRole("heading", { name: "Your API key is ready", exact: true })
          .waitFor();
        const token = await page
          .getByLabel("API key", { exact: true })
          .inputValue();
        assert.equal(token, metadata.api_key);
        assert(/^vlk_[A-Za-z0-9_-]{43}$/.test(token));
        assert.equal(
          Date.parse(metadata.expires_at) - Date.parse(metadata.created_at),
          30 * 86400000,
        );
        await page
          .getByRole("button", { name: "Generate another key", exact: true })
          .click();
        await page.getByLabel("Password", { exact: true }).waitFor();
        assert(!(await page.content()).includes(token));
        assert.equal(
          (await api("/v1/api-keys/" + metadata.id, primary, "DELETE")).status,
          200,
        );
      },
    );
    await check(
      "Shared MCP consent shows the registered client and completes PKCE approval and cancellation",
      async () => {
        const callback = apiUrl + "/oauth-browser-callback";
        const registration = await api("/oauth/register", undefined, "POST", {
          client_name: "Example MCP client",
          redirect_uris: [callback],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code"],
          response_types: ["code"],
        });
        assert.equal(registration.status, 201);
        const clientId = String(registration.data.client_id);
        for (const action of ["allow", "deny"] as const) {
          const verifier = randomBytes(32).toString("base64url");
          const state = randomBytes(32).toString("base64url");
          const parameters = new URLSearchParams({
            response_type: "code",
            client_id: clientId,
            redirect_uri: callback,
            resource: apiUrl + "/mcp",
            scope: "health:read",
            state,
            code_challenge: pkceChallenge(verifier),
            code_challenge_method: "S256",
          });
          await page.goto(apiUrl + "/oauth/authorize?" + parameters);
          await page.waitForURL(uiUrl + "/oauth/authorize");
          await page
            .getByRole("heading", {
              name: "Connect Example MCP client",
              exact: true,
            })
            .waitFor();
          await page
            .getByText(
              "Allow Example MCP client to read your health ledger for 30 days.",
              { exact: true },
            )
            .waitFor();
          const positions = await page.evaluate(() => {
            const cancel = Array.from(document.querySelectorAll("button")).find(
              (button) => button.textContent === "Cancel",
            )!;
            const returnTo = Array.from(document.querySelectorAll("p")).find(
              (paragraph) => paragraph.textContent?.startsWith("Return to "),
            )!;
            return {
              cancel: cancel.getBoundingClientRect().bottom,
              returnTo: returnTo.getBoundingClientRect().top,
            };
          });
          assert(positions.returnTo > positions.cancel);
          if (action === "allow") {
            await page
              .getByLabel("Email", { exact: true })
              .fill(credentials.email);
            await page
              .getByLabel("Password", { exact: true })
              .fill("incorrect-password");
            await page
              .getByRole("button", {
                name: "Connect Example MCP client",
                exact: true,
              })
              .click();
            await page
              .getByText("Invalid credentials", { exact: true })
              .waitFor();
            assert.equal(
              await page.getByLabel("Password", { exact: true }).inputValue(),
              "",
            );
            await page
              .getByLabel("Password", { exact: true })
              .fill(credentials.password);
            await page
              .getByRole("button", {
                name: "Connect Example MCP client",
                exact: true,
              })
              .click();
          } else
            await page
              .getByRole("button", { name: "Cancel", exact: true })
              .click();
          await page.waitForURL(callback + "?*");
          const returned = new URL(page.url()).searchParams;
          assert.equal(returned.get("state"), state);
          assert.equal(returned.get("iss"), apiUrl);
          assert(!returned.has("access_token"));
          if (action === "allow") {
            assert(/^voc_[A-Za-z0-9_-]{43}$/.test(returned.get("code") ?? ""));
            const exchange = await context.request.post(
              apiUrl + "/oauth/token",
              {
                form: {
                  grant_type: "authorization_code",
                  client_id: clientId,
                  redirect_uri: callback,
                  resource: apiUrl + "/mcp",
                  code: returned.get("code")!,
                  code_verifier: verifier,
                },
              },
            );
            assert.equal(exchange.status(), 200);
            const token = (await exchange.json()).access_token as string;
            const key = (
              await connection!.pool.query(
                "select id from api_keys where token_digest=$1",
                [createHash("sha256").update(token).digest("hex")],
              )
            ).rows[0];
            assert.equal(
              (await api("/v1/api-keys/" + key.id, primary, "DELETE")).status,
              200,
            );
          } else {
            assert.equal(returned.get("error"), "access_denied");
            assert(!returned.has("code"));
          }
        }
        await startApi();
        const longName = "M".repeat(100);
        const longClient = await api("/oauth/register", undefined, "POST", {
          client_name: longName,
          redirect_uris: [callback],
          token_endpoint_auth_method: "none",
        });
        assert.equal(longClient.status, 201);
        const parameters = new URLSearchParams({
          response_type: "code",
          client_id: String(longClient.data.client_id),
          redirect_uri: callback,
          resource: apiUrl + "/mcp",
          state: "long-name",
          code_challenge: pkceChallenge(randomBytes(32).toString("base64url")),
          code_challenge_method: "S256",
        });
        await page.setViewportSize({ width: 320, height: 844 });
        await page.goto(apiUrl + "/oauth/authorize?" + parameters);
        await page
          .getByRole("heading", { name: "Connect " + longName, exact: true })
          .waitFor();
        assert(
          !(await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          )),
          "Registered client names must wrap on mobile",
        );
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await page.waitForURL(callback + "?*");
        await page.setViewportSize({ width: 1280, height: 1000 });
        await page.goto(uiUrl + "/oauth/authorize");
        await page.getByText("Connection expired", { exact: true }).waitFor();
        assert.equal(
          await page
            .getByRole("button", { name: "Connect to Vitalog", exact: true })
            .isDisabled(),
          true,
        );
      },
    );
    await check(
      "Shared sign-in retains pending credentials, clears failed passwords and allows retries on desktop/mobile in both themes",
      async () => {
        for (const width of [390, 1280]) {
          for (const colorScheme of ["light", "dark"] as const) {
            const signInContext = await browser!.newContext({
              viewport: { width, height: 900 },
              colorScheme,
            });
            let releaseResponse!: () => void;
            const responseGate = new Promise<void>((resolve) => {
              releaseResponse = resolve;
            });
            try {
              const signInPage = await signInContext.newPage();
              let requestSeen!: () => void;
              const received = new Promise<void>((resolve) => {
                requestSeen = resolve;
              });
              let requests = 0;
              await signInPage.route(uiUrl + "/auth/login", async (route) => {
                requests++;
                requestSeen();
                await responseGate;
                await route.fulfill({ status: 401, json: {} });
              });
              await signInPage.goto(uiUrl + "/login");
              await signInPage
                .getByRole("heading", { name: "Sign in", exact: true })
                .waitFor();
              await signInPage
                .getByText("Sign in to your account.", { exact: true })
                .waitFor();
              const email = signInPage.getByLabel("Email", { exact: true });
              const password = signInPage.getByLabel("Password", {
                exact: true,
              });
              await email.fill(credentials.email);
              await password.fill("incorrect-password");
              await signInPage
                .getByRole("button", { name: "Sign in", exact: true })
                .click();
              await received;
              const pending = signInPage.getByRole("button", {
                name: /^Signing in/,
              });
              await pending.waitFor();
              assert(await pending.isDisabled());
              assert(await email.isDisabled());
              assert(await password.isDisabled());
              assert.equal(await email.inputValue(), credentials.email);
              assert.equal(await password.inputValue(), "incorrect-password");
              releaseResponse();
              await signInPage
                .getByText("Invalid credentials", { exact: true })
                .waitFor();
              await signInPage.waitForFunction(
                () =>
                  document.querySelector<HTMLInputElement>(
                    'input[type="password"]',
                  )?.value === "",
              );
              assert.equal(await email.inputValue(), credentials.email);
              assert.equal(
                await signInPage
                  .getByRole("button", {
                    name: /forgot password|passkey|verification email|verify email/i,
                  })
                  .count(),
                0,
              );
              assert.equal(
                await signInPage.locator("html").getAttribute("data-theme"),
                colorScheme,
              );
              assert(
                await signInPage.evaluate(
                  () => document.documentElement.scrollWidth <= innerWidth,
                ),
                "Sign-in must fit the viewport",
              );
              await password.fill("retry-password");
              const retry = signInPage.waitForResponse(
                (response) => response.url() === uiUrl + "/auth/login",
              );
              await signInPage
                .getByRole("button", { name: "Sign in", exact: true })
                .click();
              assert.equal((await retry).status(), 401);
              await signInPage.waitForFunction(
                () =>
                  document.querySelector<HTMLInputElement>(
                    'input[type="password"]',
                  )?.value === "",
              );
              assert.equal(requests, 2);
              assert.equal(await email.inputValue(), credentials.email);
              await signInPage.screenshot({
                path: `.test-artifacts/web/sign-in-${width}-${colorScheme}.png`,
                animations: "disabled",
              });
            } finally {
              releaseResponse();
              await signInContext.close();
            }
          }
        }
      },
    );
    await check(
      "Native authentication submissions cannot put credentials in URLs before hydration",
      async () => {
        const nativeContext = await browser!.newContext({
          javaScriptEnabled: false,
        });
        try {
          const nativePage = await nativeContext.newPage();
          const requestedUrls: string[] = [];
          nativePage.on("request", (request) =>
            requestedUrls.push(request.url()),
          );
          for (const [path, submitLabel] of [
            ["/login", "Sign in"],
            ["/api-keys", "Generate API key"],
          ]) {
            const response = await nativePage.goto(uiUrl + path);
            assert.match(
              response!.headers()["content-security-policy"]!,
              /form-action 'none'/,
            );
            await nativePage
              .getByLabel("Email", { exact: true })
              .fill("nojs@example.test");
            await nativePage
              .getByLabel("Password", { exact: true })
              .fill("native-must-not-be-a-query");
            const blocked = nativePage.waitForEvent("console", {
              predicate: (message) => message.text().includes("form-action"),
            });
            await nativePage
              .getByRole("button", { name: submitLabel, exact: true })
              .click({ noWaitAfter: true });
            await blocked;
            assert.equal(nativePage.url(), uiUrl + path);
            assert(
              requestedUrls.every(
                (url) =>
                  !url.includes("native-must-not-be-a-query") &&
                  !url.includes("nojs%40example.test"),
              ),
            );
          }
        } finally {
          await nativeContext.close();
        }
      },
    );
    await check(
      "Login protects both routes, rejects bad credentials with a toast, and uses an HttpOnly cookie",
      async () => {
        await startApi();
        await page.goto(uiUrl + "/daily");
        await page.waitForURL("**/login");
        await page.getByLabel("Email", { exact: true }).fill(credentials.email);
        await page
          .getByLabel("Password", { exact: true })
          .fill("incorrect-password");
        await page
          .getByRole("button", { name: "Sign in", exact: true })
          .click();
        await page.getByText("Invalid credentials", { exact: true }).waitFor();
        assert.equal(
          await page.getByLabel("Password", { exact: true }).inputValue(),
          "",
        );
        await page
          .getByLabel("Password", { exact: true })
          .fill(credentials.password);
        const signedIn = page.waitForResponse(
          (response) =>
            response.url() === uiUrl + "/auth/login" &&
            response.request().method() === "POST",
        );
        await page
          .getByRole("button", { name: "Sign in", exact: true })
          .click();
        assert.equal(
          (await signedIn).status(),
          200,
          "Successful root sign-in should create the browser cookie",
        );
        await page.waitForURL("**/daily");
        await page.getByRole("heading", { name: "Daily nutrition" }).waitFor();
        const session = (await context.cookies()).find(
          (cookie) => cookie.name === "vitalog-session",
        );
        assert(session?.httpOnly);
        assert.equal(session.sameSite, "Lax");
        assert(
          !(await page.evaluate(() => document.cookie)).includes(session.value),
        );
        assert(!(await page.content()).includes(session.value));
        assert.deepEqual(
          await page.evaluate(() => ({
            local: localStorage.length,
            session: sessionStorage.length,
          })),
          { local: 0, session: 0 },
        );
        const login = await context.request.post(uiUrl + "/auth/login", {
          data: credentials,
          headers: { Origin: "https://foreign.example" },
        });
        assert.equal(login.status(), 403);
        assert.equal(
          (
            await context.request.post(uiUrl + "/auth/logout", {
              headers: { Origin: "https://foreign.example" },
            })
          ).status(),
          403,
        );
      },
    );
    await check(
      "Account profile and date/time preferences persist without health write privileges",
      async () => {
        const token = (await context.cookies()).find(
          (cookie) => cookie.name === "vitalog-session",
        )!.value;
        const before = (await api("/auth/session", token)).data;
        const original = object(object(before.account).preferences);
        const originalName = String(object(before.account).name);
        for (const path of ["/auth/profile", "/auth/preferences"]) {
          const method = path.endsWith("profile") ? "PATCH" : "PUT";
          const body = path.endsWith("profile")
            ? { name: "Updated name" }
            : original;
          assert.equal((await api(path, primary, method, body)).status, 401);
          assert.equal((await api(path, undefined, method, body)).status, 401);
          assert.equal(
            (
              await api(path, token, method, body, {
                Origin: "https://foreign.example",
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await context.request.fetch(uiUrl + path, {
                method,
                data: body,
                headers: { Origin: "https://foreign.example" },
              })
            ).status(),
            403,
          );
        }
        assert.equal(
          (
            await api("/auth/profile", token, "PATCH", {
              name: " ",
              email: "changed@example.test",
            })
          ).status,
          422,
        );
        assert.equal(
          (
            await api("/auth/preferences", token, "PUT", {
              ...original,
              timeZone: "Invalid/Zone",
            })
          ).status,
          422,
        );
        await page.goto(uiUrl + "/settings/profile");
        const name = page.getByLabel("Full name", { exact: true });
        await name.fill("Preview Reader");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await page
          .getByRole("button", {
            name: "Account menu for Preview Reader",
            exact: true,
          })
          .waitFor();
        await page.reload();
        assert.equal(await name.inputValue(), "Preview Reader");
        assert.equal(
          await page.getByText("Security", { exact: true }).count(),
          0,
        );
        assert.equal(
          await page.getByText("Account settings", { exact: true }).count(),
          1,
        );
        assert.equal(
          await page
            .getByRole("link", {
              name: "Edit Gravatar image (opens in a new tab)",
            })
            .count(),
          1,
        );
        const preference = {
          dateFormat: "year-month-day",
          timeFormat: "24-hour-seconds",
          timeZone: "America/New_York",
        };
        await page.goto(uiUrl + "/settings/preferences");
        await page.getByRole("button", { name: /Date format/ }).click();
        await page
          .getByRole("option", { name: "2026-09-16", exact: true })
          .click();
        await page.getByRole("button", { name: /Time format/ }).click();
        await page
          .getByRole("option", { name: "14:30:45", exact: true })
          .click();
        await page.getByRole("button", { name: /Time zone/ }).click();
        await page
          .getByRole("searchbox", { name: "Search time zones" })
          .fill("America/New_York");
        await page.getByRole("option", { name: /America\/New_York/ }).click();
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await page.getByText("Preferences updated", { exact: true }).waitFor();
        await page.reload();
        await startApi(false);
        assert.equal((await api("/auth/session", token)).status, 401);
        assert.equal(
          (
            await api("/auth/profile", token, "PATCH", {
              name: "Changed while disabled",
            })
          ).status,
          401,
        );
        assert.equal((await api("/v1/goals", token)).status, 200);
        await startApi();
        const after = (await api("/auth/session", token)).data;
        assert.deepEqual(object(after.account).preferences, preference);
        assert.equal(after.today, before.today);
        assert.equal(after.timezone, before.timezone);
        const stored = await connection!.pool.query(
          "select name,date_format,time_format,time_zone from account_settings where id=1",
        );
        assert.equal(stored.rows[0].name, "Preview Reader");
        assert.equal(stored.rows[0].time_zone, "America/New_York");
        await page.goto(uiUrl + "/daily");
        await page.getByRole("heading", { name: new RegExp(today) }).waitFor();
        await page
          .getByRole("heading", { name: "Daily nutrition", exact: true })
          .waitFor();
        const sizes = await page
          .locator(".macro .metric-title svg, .metric-card .widget__title svg")
          .evaluateAll((nodes) =>
            nodes
              .map((node) => {
                const box = node.getBoundingClientRect();
                return [box.width, box.height];
              })
              .filter(([width, height]) => width! > 0 && height! > 0),
          );
        assert.equal(sizes.length, 9);
        assert(sizes.every(([w, h]) => w === 16 && h === 16));
        await api("/auth/profile", token, "PATCH", { name: originalName });
        await api("/auth/preferences", token, "PUT", original);
        await page.reload();
      },
    );
    await check(
      "Daily shows real metrics and mixed logs with the agreed responsive card layout",
      async () => {
        await page.waitForFunction(
          () =>
            document.querySelectorAll(
              '.metric-card[aria-label="Daily nutrition"]',
            ).length === 1,
        );
        for (const [name, value] of [
          ["Daily nutrition", "1,460"],
          ["Water", "1,350"],
          ["Calories burned", "280"],
          ["Active minutes", "45"],
          ["Mood", "Good"],
        ])
          assert(
            (
              await page
                .locator(`.metric-card[aria-label="${name}"]`)
                .innerText()
            ).includes(value!),
          );
        assert.equal(await page.locator(".macro").count(), 4);
        assert.equal(await page.locator(".log-trigger").count(), 11);
        for (const width of [
          1440, 1280, 1080, 896, 895, 768, 736, 390, 352, 320,
        ]) {
          await page.setViewportSize({ width, height: 1000 });
          const layout = await page.evaluate<{
            cards: { x: number; y: number; width: number }[];
            macros: { x: number; y: number; width: number }[];
            logs: { x: number; y: number; width: number };
            overflow: boolean;
          }>(`(() => {
            const rect = selector => Array.from(document.querySelectorAll(selector)).map(el => {
              const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width };
            });
            return { cards: rect('.daily-metrics > .metric-card'), macros: rect('.macro'), logs: rect('.logs-card')[0], overflow: document.documentElement.scrollWidth > innerWidth };
          })()`);
          assert(!layout.overflow, `Overflow at ${width}`);
          assert(layout.cards[0]!.width > layout.cards[1]!.width);
          assert.equal(layout.cards[1]!.y, layout.cards[2]!.y);
          assert.equal(layout.cards[3]!.y, layout.cards[4]!.y);
          assert(layout.cards[3]!.y > layout.cards[1]!.y);
          assert.equal(layout.macros[0]!.y, layout.macros[1]!.y);
          assert(layout.macros[2]!.y > layout.macros[0]!.y);
          if (width >= 896) {
            assert(layout.logs.x > layout.cards[0]!.x);
            assert.equal(layout.logs.y, layout.cards[0]!.y);
          } else {
            assert.equal(layout.logs.x, layout.cards[0]!.x);
            assert(layout.logs.y > layout.cards[4]!.y);
          }
        }
        await page.setViewportSize({ width: 1280, height: 1000 });
        await page.screenshot({
          path: ".test-artifacts/web/daily-desktop.png",
          fullPage: true,
          animations: "disabled",
        });
        const nutritionLog = page.getByRole("button", {
          name: /Nutrition.*460 kcal/,
        });
        await nutritionLog.click();
        await page.getByText("Dinner", { exact: true }).waitFor();
        await page.screenshot({
          path: ".test-artifacts/web/daily-expanded.png",
          fullPage: true,
          animations: "disabled",
        });
        assert(
          !(await page.locator("#main-content").innerText()).includes(
            "Estimate",
          ),
        );
        assert(
          !(await page.locator("#main-content").innerText()).includes(
            "Current weight",
          ),
        );
        await page.emulateMedia({ colorScheme: "dark" });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({
          path: ".test-artifacts/web/daily-mobile-dark.png",
          fullPage: true,
          animations: "disabled",
        });
        await page.emulateMedia({ colorScheme: "light" });
      },
    );
    await check(
      "Daily and Weight show real headings while matching card surfaces during delayed loads",
      async () => {
        await page.setViewportSize({ width: 1280, height: 900 });
        for (const colorScheme of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme });
          for (const view of ["daily", "weight"] as const) {
            let release!: () => void;
            healthReadGate = new Promise<void>((resolve) => {
              release = resolve;
            });
            try {
              await page.goto(
                uiUrl +
                  (view === "daily" ? `/daily?date=${yesterday}` : "/weight"),
                { waitUntil: "commit" },
              );
              await page
                .getByRole("heading", {
                  name:
                    view === "daily"
                      ? new RegExp(`^${dateLabel(yesterday)}\\s+Choose date$`)
                      : "Weight",
                  exact: true,
                })
                .waitFor();
              await page
                .getByRole("status", { name: "Loading health data" })
                .waitFor();
              const surface = await page
                .locator(".loading-surface")
                .first()
                .evaluate((element) => ({
                  card: getComputedStyle(element).backgroundColor,
                  skeleton: getComputedStyle(
                    element.querySelector(".loading-fill")!,
                  ).backgroundColor,
                }));
              assert.equal(surface.card, surface.skeleton);
              assert.equal(await page.locator("h1 .skeleton").count(), 0);
              assert.equal(
                await page
                  .locator("h1")
                  .evaluate(
                    (heading) =>
                      heading.closest("header")?.querySelectorAll("p").length,
                  ),
                0,
              );
              await page.screenshot({
                path: `.test-artifacts/web/loading-${view}-${colorScheme}.png`,
                animations: "disabled",
              });
            } finally {
              healthReadGate = undefined;
              release();
            }
            await page.waitForLoadState("load");
            await page
              .locator(".dashboard-loading")
              .filter({ visible: true })
              .waitFor({ state: "hidden" });
          }
        }
        await page.emulateMedia({ colorScheme: "light" });
      },
    );
    await check(
      "Shared sidebar, mobile drawer, API key management and OAuth guide work without exposing session tokens",
      async () => {
        const endpointForKeys = "/auth/key-management/api-keys";
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto(uiUrl + "/daily");
        const nav = page
          .locator("#application-navigation")
          .getByRole("navigation", {
            name: "Primary navigation",
            exact: true,
          });
        await nav
          .getByRole("link", { name: "Daily View", exact: true })
          .waitFor();
        assert.equal(
          await page.locator(".desktop-nav, .mobile-nav").count(),
          0,
        );
        await page
          .getByRole("button", { name: "Toggle navigation", exact: true })
          .click();
        await page.waitForFunction(
          () =>
            document
              .querySelector(".navigation-toggle")
              ?.getAttribute("aria-expanded") === "false",
        );
        assert.equal(
          await page.locator("#application-navigation").getAttribute("inert"),
          "",
        );
        await page.reload();
        await page.waitForFunction(
          () =>
            document
              .querySelector(".navigation-toggle")
              ?.getAttribute("aria-expanded") === "false",
        );
        await page
          .getByRole("button", { name: "Toggle navigation", exact: true })
          .click();
        assert.equal(
          await nav
            .getByRole("link")
            .allTextContents()
            .then(
              (labels) => labels.filter((label) => /team/i.test(label)).length,
            ),
          0,
        );
        await nav
          .getByRole("link", { name: "Account settings", exact: true })
          .click();
        const settingsNav = page.getByRole("navigation", {
          name: "Page navigation",
          exact: true,
        });
        await settingsNav
          .getByRole("link", { name: "API Keys", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "API Keys", exact: true })
          .waitFor();
        assert.equal(
          await nav
            .getByRole("link", { name: "Account settings", exact: true })
            .getAttribute("aria-current"),
          "page",
        );
        assert.equal(
          await settingsNav
            .getByRole("link", { name: "API Keys", exact: true })
            .getAttribute("aria-current"),
          "page",
        );
        await page
          .getByRole("heading", { name: "API Keys", exact: true })
          .waitFor();
        await page.getByText("No API keys yet", { exact: true }).waitFor();
        assert.equal(
          await page
            .getByRole("button", { name: "Verify identity", exact: true })
            .count(),
          0,
        );
        await page
          .getByRole("button", { name: "Create API key", exact: true })
          .click();
        await page
          .getByRole("dialog", { name: "Create API key", exact: true })
          .getByRole("button", { name: "Create API key", exact: true })
          .click();
        const verification = page.getByRole("dialog", {
          name: "Confirm it’s you",
          exact: true,
        });
        await verification
          .getByLabel("Email", { exact: true })
          .fill(credentials.email);
        await verification
          .getByLabel("Password", { exact: true })
          .fill("Incorrect-settings-password-2026!");
        await verification
          .getByRole("button", { name: "Continue", exact: true })
          .click();
        await page.getByText("Invalid credentials", { exact: true }).waitFor();
        assert.equal(
          await verification
            .getByLabel("Password", { exact: true })
            .inputValue(),
          "",
        );
        await verification
          .getByLabel("Password", { exact: true })
          .fill(credentials.password);
        const unlock = page.waitForResponse(
          (response) => response.url() === uiUrl + "/auth/key-management/login",
        );
        await verification
          .getByRole("button", { name: "Continue", exact: true })
          .click();
        const unlocked = await unlock;
        assert.equal(unlocked.status(), 200);
        assert.deepEqual(await unlocked.json(), { signed_in: true });
        await verification.waitFor({ state: "hidden" });
        await page.getByText("No API keys yet", { exact: true }).waitFor();
        const management = (await context.cookies()).find(
          (cookie) => cookie.name === "vitalog-key-management",
        )!;
        assert(management.httpOnly && management.sameSite === "Lax");
        assert(/^vlm_/.test(management.value));
        assert(
          !(await page.evaluate(
            `JSON.stringify(localStorage).includes(${JSON.stringify(management.value)})`,
          )),
        );
        for (const method of ["POST", "DELETE"]) {
          assert.equal(
            (
              await context.request.fetch(uiUrl + endpointForKeys, {
                method,
                headers: { Origin: "https://foreign.example" },
              })
            ).status(),
            403,
          );
        }
        assert.equal(
          (
            await context.request.post(uiUrl + endpointForKeys, {
              data: "unexpected body",
              headers: { Origin: uiUrl },
            })
          ).status(),
          422,
        );
        const generated: string[] = [];
        for (let index = 0; index < 2; index++) {
          await page
            .getByRole("button", { name: "Create API key", exact: true })
            .click();
          const dialog = page.getByRole("dialog", {
            name: "Create API key",
            exact: true,
          });
          assert.equal(
            await dialog.getByLabel("Name", { exact: true }).count(),
            0,
          );
          if (index === 0) {
            await page.route(uiUrl + endpointForKeys, async (route) => {
              if (route.request().method() === "POST")
                await route.fulfill({
                  status: 503,
                  contentType: "application/json",
                  body: "{}",
                });
              else await route.continue();
            });
            await dialog
              .getByRole("button", { name: "Create API key", exact: true })
              .click();
            await page
              .getByText("Unable to create an API key. Try again.", {
                exact: true,
              })
              .waitFor();
            assert(
              await dialog.isVisible(),
              "A failed create must leave the shared confirmation open for retry",
            );
            await page.unroute(uiUrl + endpointForKeys);
          }
          await dialog
            .getByRole("button", { name: "Create API key", exact: true })
            .click();
          const revealed = page.getByRole("dialog", {
            name: "Copy your API key",
            exact: true,
          });
          const secret = await revealed
            .getByLabel("API key", { exact: true })
            .inputValue();
          assert(/^vlk_[A-Za-z0-9_-]{43}$/.test(secret));
          generated.push(secret);
          assert.equal((await api("/v1/goals", secret)).status, 200);
          await revealed
            .getByRole("button", { name: "Done", exact: true })
            .click();
          await revealed.waitFor({ state: "hidden" });
          assert(
            !(await page
              .locator("body")
              .innerText()
              .then((text) => text.includes(secret))),
          );
        }
        await page
          .getByRole("grid", { name: "API keys", exact: true })
          .waitFor();
        await page.screenshot({
          path: ".test-artifacts/web/api-keys-desktop.png",
          fullPage: true,
          animations: "disabled",
        });
        await page
          .getByRole("row")
          .filter({ hasText: generated[0]!.slice(-4) })
          .getByRole("button", { name: "Revoke", exact: true })
          .click();
        await page
          .getByRole("dialog", { name: "Revoke API key?", exact: true })
          .getByRole("button", { name: "Revoke API key", exact: true })
          .click();
        await page
          .getByRole("dialog", { name: "Revoke API key?", exact: true })
          .waitFor({ state: "hidden" });
        assert.equal((await api("/v1/goals", generated[0])).status, 401);
        await page
          .getByRole("button", { name: "Revoke all API keys", exact: true })
          .click();
        await page
          .getByRole("dialog", { name: "Revoke all API keys?", exact: true })
          .getByRole("button", { name: "Revoke all API keys", exact: true })
          .click();
        await page.getByText("No API keys yet", { exact: true }).waitFor();
        assert.equal((await api("/v1/goals", generated[1])).status, 401);
        const browserSession = (await context.cookies()).find(
          (cookie) => cookie.name === "vitalog-session",
        )!;
        assert.equal(
          (await api("/auth/session", browserSession.value)).status,
          200,
        );
        await settingsNav
          .getByRole("link", { name: "MCP Guide", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "MCP Guide", exact: true })
          .waitFor();
        for (const client of [
          "Codex",
          "Claude Code",
          "VS Code",
          "Other clients",
          "Cursor",
        ]) {
          await page.getByRole("button", { name: / Client$/ }).click();
          await page.getByRole("option", { name: client, exact: true }).click();
          assert(
            (
              await page
                .getByLabel("MCP configuration", { exact: true })
                .innerText()
            ).includes(apiUrl + "/mcp"),
          );
        }
        assert(
          (
            await page
              .getByLabel("MCP configuration", { exact: true })
              .innerText()
          ).includes(apiUrl + "/mcp"),
        );
        await page.screenshot({
          path: ".test-artifacts/web/mcp-guide-desktop.png",
          fullPage: true,
          animations: "disabled",
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await page
          .getByRole("button", { name: "Toggle navigation", exact: true })
          .click();
        const drawer = page.getByRole("dialog", {
          name: "Navigation",
          exact: true,
        });
        await drawer.waitFor();
        await drawer
          .getByRole("link", { name: "MCP Guide", exact: true })
          .waitFor();
        assert.equal(
          await drawer
            .getByRole("link", { name: "MCP Guide", exact: true })
            .getAttribute("aria-current"),
          "page",
        );
        assert(
          await drawer.evaluate((element) =>
            element.contains(document.activeElement),
          ),
        );
        await page.screenshot({
          path: ".test-artifacts/web/sidebar-mobile.png",
          animations: "disabled",
        });
        await page.keyboard.press("Escape");
        await drawer.waitFor({ state: "hidden" });
        assert.equal(
          await page
            .locator(".navigation-toggle")
            .evaluate((element) => element === document.activeElement),
          true,
        );
        await page
          .getByRole("button", { name: "Toggle navigation", exact: true })
          .click();
        await drawer
          .getByRole("link", { name: "Daily View", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "Daily nutrition", exact: true })
          .waitFor();
        await drawer.waitFor({ state: "hidden" });
        assert(
          !(await page.evaluate(
            "document.documentElement.scrollWidth > innerWidth",
          )),
        );
        await page.setViewportSize({ width: 1280, height: 900 });
        await nav
          .getByRole("link", { name: "Account settings", exact: true })
          .click();
        await settingsNav
          .getByRole("link", { name: "API Keys", exact: true })
          .click();
        await page.getByText("No API keys yet", { exact: true }).waitFor();
        await connection!.pool.query(
          "update oauth_access_tokens set created_at=created_at - interval '31 minutes', expires_at=expires_at - interval '31 minutes' where token_digest=$1",
          [createHash("sha256").update(management.value).digest("hex")],
        );
        await page
          .getByRole("button", { name: "Create API key", exact: true })
          .click();
        await page
          .getByRole("dialog", { name: "Create API key", exact: true })
          .getByRole("button", { name: "Create API key", exact: true })
          .click();
        await verification.waitFor();
        await verification
          .getByLabel("Email", { exact: true })
          .fill(credentials.email);
        await verification
          .getByLabel("Password", { exact: true })
          .fill(credentials.password);
        await verification
          .getByRole("button", { name: "Continue", exact: true })
          .click();
        await verification.waitFor({ state: "hidden" });
        await page.getByText("No API keys yet", { exact: true }).waitFor();
        assert.equal(
          (await api("/auth/key-management/session", management.value)).status,
          401,
        );
      },
    );
    await check(
      "Weight uses the explicit 78 kg baseline and 70 kg target, with 52.5% observed progress",
      async () => {
        await page.goto(uiUrl + "/weight");
        await page.getByRole("heading", { name: "Current weight" }).waitFor();
        await page.waitForFunction(
          () => document.querySelectorAll(".current-weight-card").length === 1,
        );
        assert(
          (await page.locator(".current-weight-card").innerText()).includes(
            "73.8",
          ),
        );
        assert(
          (await page.locator(".weight-goal").innerText()).includes(
            "Start 78 kg",
          ),
        );
        assert(
          (await page.locator(".weight-goal").innerText()).includes(
            "Target 70 kg",
          ),
        );
        assert.equal(
          await page
            .getByRole("progressbar", { name: "Weight goal progress" })
            .getAttribute("aria-valuenow"),
          "52.5",
        );
        assert.equal(await page.locator(".weight-reading").count(), 7);
        assert.equal(await page.locator(".chart-point").count(), 7);
        await page.screenshot({
          path: ".test-artifacts/web/weight-mobile.png",
          fullPage: true,
          animations: "disabled",
        });
        await page.setViewportSize({ width: 1280, height: 900 });
        const chart = page.locator(".weight-chart-frame");
        await page.locator(".chart-point").last().hover();
        await page.getByRole("tooltip").waitFor();
        assert(
          (await page.getByRole("tooltip").innerText()).includes("73.8 kg"),
        );
        await page.screenshot({
          path: ".test-artifacts/web/weight-chart-hover.png",
          animations: "disabled",
        });
        await chart.press("Home");
        await page
          .getByRole("tooltip")
          .getByText("78 kg", { exact: true })
          .waitFor();
        await chart.press("ArrowRight");
        await page
          .getByRole("tooltip")
          .getByText("77.2 kg", { exact: true })
          .waitFor();
        await chart.press("Escape");
        await page.getByRole("tooltip").waitFor({ state: "hidden" });
        assert.equal(await page.locator(".chart-date").count(), 5);
        assert.equal(
          await page.locator(".chart-axis-x, .chart-axis-y").count(),
          2,
        );
        const touchContext = await browser!.newContext({
          hasTouch: true,
          viewport: { width: 390, height: 844 },
          colorScheme: "dark",
        });
        try {
          await touchContext.addCookies(await context.cookies());
          const touchPage = await touchContext.newPage();
          await touchPage.goto(uiUrl + "/weight");
          await touchPage.locator(".chart-point").last().tap();
          await touchPage.getByRole("tooltip").waitFor();
          assert(
            (await touchPage.getByRole("tooltip").innerText()).includes(
              "73.8 kg",
            ),
          );
          await touchPage.screenshot({
            path: ".test-artifacts/web/weight-chart-touch.png",
            fullPage: true,
            animations: "disabled",
          });
        } finally {
          await touchContext.close();
        }
        await page.screenshot({
          path: ".test-artifacts/web/weight-desktop.png",
          fullPage: true,
          animations: "disabled",
        });
      },
    );
    await check(
      "Date navigation preserves unknown nutrition and mood while showing explicitly reported zeros",
      async () => {
        await page.goto(uiUrl + "/daily?date=" + yesterday);
        await page.getByRole("heading", { name: "Daily nutrition" }).waitFor();
        await page.waitForFunction(
          () => document.querySelectorAll(".nutrition-card").length === 1,
        );
        assert(
          (
            await page
              .locator(".nutrition-card > .widget__content > .metric-value")
              .innerText()
          ).startsWith("—"),
        );
        assert.equal(await page.locator(".mood-value").innerText(), "—");
        for (const name of ["Water", "Calories burned", "Active minutes"])
          assert(
            (
              await page
                .locator(`.metric-card[aria-label="${name}"] .metric-value`)
                .innerText()
            ).startsWith("0"),
          );
        const picker = page.getByRole("button", {
          name: "Choose date",
          exact: true,
        });
        const calendarDate = (day: string) =>
          new Intl.DateTimeFormat("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
            year: "numeric",
            timeZone: "UTC",
          }).format(new Date(day + "T12:00:00Z"));
        await picker.click();
        if (yesterday.slice(0, 7) !== today.slice(0, 7))
          await page.locator(".calendar__nav-button").last().click();
        await page.getByRole("button", { name: calendarDate(today) }).click();
        await page.waitForURL("**/daily");
        await page.getByRole("heading", { name: "Daily nutrition" }).waitFor();
        await page
          .getByRole("dialog", { name: "Choose a day" })
          .waitFor({ state: "hidden" });
        await picker.click();
        await page.screenshot({
          path: ".test-artifacts/web/daily-calendar-desktop.png",
          animations: "disabled",
        });
        const tomorrow = dateOffset(today, 1);
        if (tomorrow.slice(0, 7) === today.slice(0, 7))
          assert.equal(
            await page
              .getByRole("button", {
                name: calendarDate(tomorrow),
                exact: true,
              })
              .isDisabled(),
            true,
          );
        else
          assert.equal(
            await page.locator(".calendar__nav-button").last().isDisabled(),
            true,
          );
        await page.keyboard.press("Escape");
        await picker.waitFor({ state: "visible" });
        await page
          .getByRole("dialog", { name: "Choose a day" })
          .waitFor({ state: "hidden" });
        await page.waitForFunction(
          () =>
            document.activeElement?.getAttribute("aria-label") ===
            "Choose date",
        );
        await page.goto(uiUrl + "/daily?date=2026-02-30");
        await page.getByRole("heading", { name: "Page not found" }).waitFor();
        await page.goto(uiUrl + "/daily?date=" + dateOffset(today, -45));
        await page.getByRole("heading", { name: "Daily nutrition" }).waitFor();
        assert(
          (
            await page
              .locator('.metric-card[aria-label="Water"] .metric-value')
              .filter({ visible: true })
              .innerText()
          ).startsWith("206"),
        );
        for (let index = 0; index < 6; index++)
          await page
            .getByRole("button", { name: "Show more", exact: true })
            .click();
        assert.equal(await page.locator(".log-trigger").count(), 206);
        await page.goto(uiUrl + "/daily?date=" + dateOffset(today, -60));
        await page
          .getByText("No logs for this day.", { exact: true })
          .filter({ visible: true })
          .waitFor();
      },
    );
    await check(
      "Sign-out revokes the session and key administration revokes an existing signed-in browser",
      async () => {
        const session = (await context.cookies()).find(
          (cookie) => cookie.name === "vitalog-session",
        )!;
        const management = (await context.cookies()).find(
          (cookie) => cookie.name === "vitalog-key-management",
        )!;
        await page.setViewportSize({ width: 1280, height: 900 });
        await page
          .locator("#application-navigation")
          .getByRole("button", { name: /^Account menu for/ })
          .click();
        await page
          .getByRole("menuitem", { name: "Sign out", exact: true })
          .click();
        await page.waitForURL("**/login");
        assert.equal((await api("/v1/goals", session.value)).status, 401);
        assert.equal(
          (await api("/auth/key-management/session", management.value)).status,
          401,
        );
        await page.goto(uiUrl + "/weight");
        await page.waitForURL("**/login");
        await startApi();
        await page.getByLabel("Email", { exact: true }).fill(credentials.email);
        await page
          .getByLabel("Password", { exact: true })
          .fill(credentials.password);
        await page
          .getByRole("button", { name: "Sign in", exact: true })
          .click();
        await page.waitForURL("**/daily");
        await page.getByRole("heading", { name: "Daily nutrition" }).waitFor();
        const issued = (await context.cookies()).find(
          (cookie) => cookie.name === "vitalog-session",
        )!;
        const listed = await api("/v1/api-keys", primary);
        assert.equal(listed.status, 200);
        assert(!listed.text.includes(issued.value));
        const key = (
          await connection!.pool.query(
            "select id from api_keys where token_digest=$1",
            [createHash("sha256").update(issued.value).digest("hex")],
          )
        ).rows[0];
        assert.equal(
          (await api("/v1/api-keys/" + key.id, primary, "DELETE")).status,
          200,
        );
        await page.goto(uiUrl + "/daily");
        await page.waitForURL("**/login");
        assert.equal((await api("/auth/session", issued.value)).status, 401);
      },
    );
    assert.deepEqual(failures, []);
    const logs = JSON.stringify(requestLogs) + webLog;
    assert(!logs.includes(credentials.password));
    assert(!logs.includes(primary));
    await writeFile(
      ".test-artifacts/web-verification.json",
      JSON.stringify(
        {
          checked_at: new Date().toISOString(),
          fixture: "disposable PostgreSQL",
          checks,
          status: "passed",
        },
        null,
        2,
      ) + "\n",
    );
    process.stdout.write(
      `PASS ${checks.length} browser/session verification groups\n`,
    );
  }
} finally {
  await browser?.close();
  if (web && web.exitCode === null) {
    const exited = once(web, "exit");
    web.kill("SIGTERM");
    await exited;
  }
  await stopApi();
  await connection?.pool.end();
  try {
    docker(["rm", "-f", container]);
  } catch {
    /* Startup may fail before the container is created. */
  }
}
