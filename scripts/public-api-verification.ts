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
import { migrateDatabase } from "./migrate.js";

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
    ALLOWED_HOSTS: new URL(apiUrl).host,
    PUBLIC_BASE_URL: apiUrl,
    UI_BASE_URL: uiUrl,
    RATE_LIMIT_PER_MINUTE: "100000",
  });
  server = serve({
    fetch: application(
      new Service(
        connection.db,
        config.timezone,
        config.authDigest.toString("hex"),
      ),
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
  const hostedApi = "https://vitalog-api.avgeek.ltd";
  const hostedUi = "https://vitalog.avgeek.ltd";
  const hostedConfig = configuration({
    AUTH_KEY: primary,
    ROOT_EMAIL: credentials.email,
    ROOT_PASSWORD: credentials.password,
    DATABASE_URL: dbUrl,
    ALLOWED_HOSTS: new URL(hostedApi).host,
    PUBLIC_BASE_URL: hostedApi,
    UI_BASE_URL: hostedUi,
  });
  const hosted = application(
    new Service(
      connection.db,
      hostedConfig.timezone,
      hostedConfig.authDigest.toString("hex"),
    ),
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
