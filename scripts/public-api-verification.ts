import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { Server } from "node:http";
import { createServer } from "node:net";
import { serve } from "@hono/node-server";
import { application } from "../src/app.js";
import { configuration } from "../src/config.js";
import { database } from "../src/db/client.js";
import { Service } from "../src/service.js";
import { Goals } from "../src/domain/goals.js";
import { operations, operationByName } from "../src/registry/operations.js";
import { base } from "../tests/fixtures.js";
import { migrateDatabase } from "./migrate.js";
import { issueMcpFixtureToken } from "./mcp-fixture.js";

const container = `vitalog-public-api-${process.pid}`;
const password = randomBytes(32).toString("hex");
const credentials = {
  email: "root@example.test",
  password: randomBytes(32).toString("base64url"),
};
const primary = randomBytes(32).toString("base64url");
const docker = (args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8" }).trim();
let connection: ReturnType<typeof database> | undefined;
let server: Server | undefined;
async function port() {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  assert(address && typeof address === "object");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}
function cookie(response: Response, name: string) {
  const line = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(name + "="));
  assert(line, `Missing ${name} cookie`);
  assert.match(line, /HttpOnly/i);
  assert.match(line, /SameSite=Lax/i);
  assert(!/Domain=/i.test(line));
  return line.split(";")[0]!;
}
try {
  docker([
    "run",
    "-d",
    "--name",
    container,
    "-e",
    "POSTGRES_PASSWORD=" + password,
    "-e",
    "POSTGRES_DB=vitalog",
    "-p",
    "127.0.0.1::5432",
    "postgres:17.11-alpine",
  ]);
  const dbPort = docker(["port", container, "5432/tcp"]).split(":").at(-1)!;
  const dbUrl = `postgresql://postgres:${password}@127.0.0.1:${dbPort}/vitalog`;
  connection = database(dbUrl);
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await connection.pool.query("select 1");
      break;
    } catch {
      if (attempt === 59) throw new Error("PostgreSQL did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  await migrateDatabase(dbUrl);
  const apiUrl = `http://127.0.0.1:${await port()}`;
  const uiUrl = `http://127.0.0.1:${await port()}`;
  const config = configuration({
    AUTH_KEY: primary,
    ROOT_EMAIL: credentials.email,
    ROOT_PASSWORD: credentials.password,
    DATABASE_URL: dbUrl,

    PUBLIC_BASE_URL: apiUrl,
    UI_BASE_URL: uiUrl,
    RATE_LIMIT_PER_MINUTE: "100000",
  });
  server = serve({
    fetch: application(
      new Service(connection.db, config.authDigest.toString("hex")),
      config,
      () => {},
    ).fetch,
    port: Number(new URL(apiUrl).port),
    hostname: "127.0.0.1",
  }) as Server;
  if (!server.listening) await once(server, "listening");
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    cookies = "",
    origin = uiUrl,
    extra: Record<string, string> = {},
  ) =>
    fetch(apiUrl + path, {
      method,
      headers: {
        Origin: origin,
        ...(cookies ? { Cookie: cookies } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const preflight = await request(
    "/auth/profile",
    "OPTIONS",
    undefined,
    "",
    uiUrl,
    {
      "Access-Control-Request-Method": "PATCH",
      "Access-Control-Request-Headers": "content-type",
    },
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), uiUrl);
  assert.equal(
    preflight.headers.get("access-control-allow-credentials"),
    "true",
  );
  const login = await request("/auth/session", "POST", credentials);
  assert.equal(login.status, 201);
  assert.deepEqual(await login.json(), { signed_in: true });
  const browserCookie = cookie(login, "vitalog-session");
  const session = await request(
    "/auth/session",
    "GET",
    undefined,
    browserCookie,
  );
  if (session.status !== 200)
    process.stderr.write(
      `Session error ${session.status}: ${await session.clone().text()}\n`,
    );
  assert.equal(session.status, 200);
  assert.equal((await session.json()).account.email, credentials.email);
  const catalog = await request("/v1/catalog", "GET", undefined, browserCookie);
  assert.equal(catalog.status, 200);
  assert.equal(catalog.headers.get("access-control-allow-origin"), uiUrl);
  const profile = await request(
    "/auth/profile",
    "PATCH",
    { name: "Public API Reader" },
    browserCookie,
  );
  assert.equal(profile.status, 200);
  assert.equal((await profile.json()).name, "Public API Reader");
  const preferences = await request(
    "/auth/preferences",
    "PUT",
    { dateFormat: "year-month-day", timeFormat: "24-hour", timeZone: "UTC" },
    browserCookie,
  );
  assert.equal(preferences.status, 200);

  const ledger = new Service(connection.db, "timezone-verification");
  const instant = await ledger.execute("health_log_hydration", {
    ...base,
    occurred_on: "2026-09-09",
    occurred_at: "2026-09-09T23:30:00Z",
    timezone: "UTC",
    idempotency_key: "timezone-instant",
    data: { entry_kind: "intake", volume_ml: 250, drink_type: "water" },
  });
  await ledger.execute("health_log_hydration", {
    ...base,
    occurred_on: "2026-09-10",
    timezone: "UTC",
    idempotency_key: "timezone-date-only",
    data: { entry_kind: "intake", volume_ml: 500, drink_type: "water" },
  });
  await new Goals(
    connection.db,
    "UTC",
    () => new Date("2026-09-09T00:00:00Z"),
  ).execute(operationByName.get("health_set_goal")!, {
    metric: "hydration:water_ml",
    target: 1000,
    expected_version: 0,
    idempotency_key: "timezone-goal",
  });
  const beforeTimezoneChange = (
    await connection.pool.query(
      "select occurred_at, ended_at, occurred_on, timezone, version, time_context from health_records order by id",
    )
  ).rows;
  const utcPage = await request(
    "/v1/records?start_date=2026-09-10&end_date=2026-09-10",
    "GET",
    undefined,
    browserCookie,
  );
  assert.equal(utcPage.status, 200);
  assert.equal((await utcPage.json()).returned_count, 1);
  const cursorPage = await request(
    "/v1/records?limit=1",
    "GET",
    undefined,
    browserCookie,
  );
  const previousCursor = (await cursorPage.json()).next_cursor;
  assert(previousCursor);
  const zoneChanged = await request(
    "/auth/preferences",
    "PUT",
    {
      dateFormat: "year-month-day",
      timeFormat: "24-hour",
      timeZone: "Asia/Kolkata",
    },
    browserCookie,
  );
  assert.equal(zoneChanged.status, 200);
  const refreshed = await (
    await request("/auth/session", "GET", undefined, browserCookie)
  ).json();
  assert.equal(refreshed.timezone, "Asia/Kolkata");
  assert.equal(refreshed.account.preferences.timeZone, refreshed.timezone);
  const indiaPage = await (
    await request(
      "/v1/records?start_date=2026-09-10&end_date=2026-09-10",
      "GET",
      undefined,
      browserCookie,
    )
  ).json();
  assert.equal(indiaPage.returned_count, 2);
  assert(
    indiaPage.records.some(
      (record: { id: string }) =>
        record.id === (instant.record as { id: string }).id,
    ),
  );
  const daily = await (
    await request("/v1/days/2026-09-10", "GET", undefined, browserCookie)
  ).json();
  assert.equal(daily.timezone, "Asia/Kolkata");
  assert.equal(daily.hydration.water_ml.exact_value, 750);
  const progress = await (
    await request(
      "/v1/days/2026-09-10/goal-progress",
      "GET",
      undefined,
      browserCookie,
    )
  ).json();
  assert.equal(progress.progress[0].actual, 750);
  const mcpToken = await issueMcpFixtureToken(connection.db, apiUrl + "/mcp");
  const mcp = await fetch(apiUrl + "/mcp", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + mcpToken,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "health_get_daily_summary",
        arguments: { date: "2026-09-10" },
      },
    }),
  });
  assert.equal(mcp.status, 200);
  const mcpSummary = JSON.parse((await mcp.json()).result.content[0].text);
  assert.equal(mcpSummary.timezone, daily.timezone);
  assert.equal(mcpSummary.hydration.water_ml.exact_value, 750);
  const oldCursor = await request(
    "/v1/records?limit=1&cursor=" + encodeURIComponent(previousCursor),
    "GET",
    undefined,
    browserCookie,
  );
  assert.equal(oldCursor.status, 422);
  const afterTimezoneChange = (
    await connection.pool.query(
      "select occurred_at, ended_at, occurred_on, timezone, version, time_context from health_records order by id",
    )
  ).rows;
  assert.deepEqual(afterTimezoneChange, beforeTimezoneChange);
  const preferencesRestored = await request(
    "/auth/preferences",
    "PUT",
    { dateFormat: "year-month-day", timeFormat: "24-hour", timeZone: "UTC" },
    browserCookie,
  );
  assert.equal(preferencesRestored.status, 200);
  const utcDaily = await (
    await request("/v1/days/2026-09-10", "GET", undefined, browserCookie)
  ).json();
  assert.equal(utcDaily.hydration.water_ml.exact_value, 500);
  for (const operation of operations.filter(
    (operation) => operation.name === "health_get_trends",
  )) {
    const trend = await ledger.execute(operation.name, {
      start_date: "2026-09-09",
      end_date: "2026-09-10",
      metrics: ["hydration:water_ml"],
    });
    operation.output.parse(trend);
  }
  process.stdout.write(
    "PASS account timezone applies to REST, MCP, goal progress and pagination without modifying stored records\n",
  );

  const verified = await request(
    "/auth/key-management/session",
    "POST",
    credentials,
    browserCookie,
  );
  assert.equal(verified.status, 201);
  assert.deepEqual(await verified.json(), { signed_in: true });
  const managementCookie = cookie(verified, "vitalog-key-management");
  const both = `${browserCookie}; ${managementCookie}`;
  const created = await request(
    "/auth/key-management/api-keys",
    "POST",
    {
      name: "Verification",
      access: "read",
      includeAdmin: false,
      expiresAt: null,
    },
    both,
    uiUrl,
    { "Idempotency-Key": randomUUID() },
  );
  assert.equal(created.status, 201);
  const key = await created.json();
  assert.match(key.api_key, /^vlk_/);
  const listed = await request(
    "/auth/key-management/api-keys?kind=api-key",
    "GET",
    undefined,
    browserCookie,
  );
  assert.equal(listed.status, 200);
  assert(
    (await listed.json()).api_keys.some(
      (value: { id: string }) => value.id === key.id,
    ),
  );
  const revoked = await request(
    `/auth/key-management/api-keys/${key.id}`,
    "DELETE",
    undefined,
    both,
  );
  assert.equal(revoked.status, 200);
  const deniedWrite = await request(
    "/v1/attachments/uploads",
    "POST",
    {},
    browserCookie,
  );
  assert.equal(deniedWrite.status, 403);
  const evil = "https://evil.example";
  for (const [path, method, body, cookies] of [
    ["/auth/profile", "PATCH", { name: "Evil" }, browserCookie],
    ["/auth/key-management/api-keys", "DELETE", undefined, both],
    ["/auth/logout", "POST", undefined, both],
  ] as const) {
    const response = await request(path, method, body, cookies, evil);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
  const logout = await request("/auth/logout", "POST", undefined, both);
  assert.equal(logout.status, 200);
  assert.equal((await logout.json()).revoked, true);
  assert(
    logout.headers
      .getSetCookie()
      .some((value) => value.startsWith("vitalog-session=;")),
  );
  assert.equal(
    (await request("/auth/session", "GET", undefined, browserCookie)).status,
    401,
  );
  assert.equal(
    (await request("/auth/key-management/session", "GET", undefined, both))
      .status,
    401,
  );
  assert.equal((await request("/healthz")).status, 200);
  const hostedApi = "https://vitalog-api.praveent.com";
  const hostedUi = "https://vitalog.praveent.com";
  const hostedConfig = configuration({
    AUTH_KEY: primary,
    ROOT_EMAIL: credentials.email,
    ROOT_PASSWORD: credentials.password,
    DATABASE_URL: dbUrl,

    PUBLIC_BASE_URL: hostedApi,
    UI_BASE_URL: hostedUi,
  });
  const hosted = application(
    new Service(connection.db, hostedConfig.authDigest.toString("hex")),
    hostedConfig,
    () => {},
  );
  const hostedLogin = await hosted.request(hostedApi + "/auth/session", {
    method: "POST",
    headers: { Origin: hostedUi, "Content-Type": "application/json" },
    body: JSON.stringify(credentials),
  });
  assert.equal(hostedLogin.status, 201);
  const hostedCookie = hostedLogin.headers.get("set-cookie")!;
  assert.match(hostedCookie, /^__Host-vitalog-session=/);
  assert.match(hostedCookie, /; Secure/i);
  assert.match(hostedCookie, /; HttpOnly/i);
  assert(!/Domain=/i.test(hostedCookie));
  process.stdout.write(
    "PASS public API cross-origin session, read, account, keys, logout, CORS and recovery\n",
  );
} finally {
  if (server)
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
      server!.closeAllConnections();
    });
  if (connection) await connection.pool.end();
  try {
    docker(["rm", "-f", container]);
  } catch {}
}
