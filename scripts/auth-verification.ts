import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { Server, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { application } from "../src/app.js";
import { configuration } from "../src/config.js";
import { keyCreated, keyList, keyMetadata } from "../src/auth/contracts.js";
import { ApiKeys } from "../src/auth/keys.js";
import { database } from "../src/db/client.js";
import { Service } from "../src/service.js";
import { object, type Data } from "../src/domain/types.js";
import { examples } from "../tests/fixtures.js";
import { migrateDatabase } from "./migrate.js";
import { operations } from "../src/registry/operations.js";

const container = `vitalog-auth-${process.pid}`;
const databasePassword = randomBytes(32).toString("hex");
let primary = randomBytes(32).toString("base64url");
const rootEmail = "root@example.test";
const rootPassword = randomBytes(32).toString("base64url");
const credentials = { email: rootEmail, password: rootPassword };
const logs: Data[] = [];
const tokens: string[] = [];
const checks: { name: string; status: "passed" }[] = [];
const docker = (args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
let connection: ReturnType<typeof database> | undefined;
let service: Service;
let server: Server | undefined;
let baseUrl = "";
let config: ReturnType<typeof configuration>;
let temporary = "";
let key: Data;
async function check(name: string, run: () => Promise<void>) {
  await run();
  checks.push({ name, status: "passed" });
  process.stdout.write(`PASS ${name}\n`);
}
async function stop() {
  if (!server) return;
  const current = server;
  server = undefined;
  await new Promise<void>((resolve) => {
    current.close(() => resolve());
    current.closeAllConnections();
  });
}
async function start(root = true) {
  await stop();
  config = configuration({
    AUTH_KEY: primary,
    DATABASE_URL: connection!.pool.options.connectionString,
    ...(root ? { ROOT_EMAIL: rootEmail, ROOT_PASSWORD: rootPassword } : {}),
    RATE_LIMIT_PER_MINUTE: "100000",
  });
  service = new Service(
    connection!.db,
    config.timezone,
    config.authDigest.toString("hex"),
  );
  const instance = serve({
    fetch: application(service, config, (entry) => logs.push(entry)).fetch,
    port: 0,
    hostname: "127.0.0.1",
  });
  assert(instance instanceof Server);
  server = instance;
  if (!instance.listening) await once(instance, "listening");
  const address = instance.address();
  assert(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
  config.allowedHosts = [new URL(baseUrl).host, "vitalog.praveent.com"];
}
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  token?: string,
  extra: Record<string, string> = {},
) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { response, text, body: object(JSON.parse(text)) };
}
async function create() {
  const response = await request(
    "/auth/api-keys",
    "POST",
    credentials,
    undefined,
    { Origin: baseUrl },
  );
  assert.equal(response.response.status, 201);
  keyCreated.parse(response.body);
  tokens.push(String(response.body.api_key));
  return response.body;
}
async function denied(token: string, path = "/v1/catalog") {
  assert.equal(
    (await request(path, "GET", undefined, token)).response.status,
    401,
  );
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
  const port = docker(["port", container, "5432/tcp"]).split(":").at(-1)!;
  const url = `postgresql://postgres:${databasePassword}@127.0.0.1:${port}/vitalog`;
  connection = database(url);
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await connection.pool.query("select 1");
      break;
    } catch {
      if (attempt === 59)
        throw new Error("Disposable PostgreSQL did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  await check(
    "Forward migration preserves the ledger, existing key access and revocation while removing key names",
    async () => {
      temporary = await mkdtemp(join(tmpdir(), "vitalog-auth-migration-"));
      await mkdir(join(temporary, "meta"));
      const journal = JSON.parse(
        await readFile("drizzle/meta/_journal.json", "utf8"),
      );
      journal.entries = journal.entries.filter(
        (entry: { idx: number }) => entry.idx < 2,
      );
      await writeFile(
        join(temporary, "meta/_journal.json"),
        JSON.stringify(journal),
      );
      for (const entry of journal.entries)
        await copyFile(
          `drizzle/${entry.tag}.sql`,
          join(temporary, entry.tag + ".sql"),
        );
      await migrate(connection!.db, { migrationsFolder: temporary });
      const previous = new Service(
        connection!.db,
        "Asia/Kolkata",
        "synthetic-cursor",
      );
      const saved = object(
        (
          await previous.execute("health_log_hydration", {
            ...examples.hydration,
            idempotency_key: "auth-upgrade",
          })
        ).record,
      );
      assert.equal(await previous.ready(), false);
      const keyJournal = JSON.parse(
        await readFile("drizzle/meta/_journal.json", "utf8"),
      );
      keyJournal.entries = keyJournal.entries.filter(
        (entry: { idx: number }) => entry.idx < 3,
      );
      await writeFile(
        join(temporary, "meta/_journal.json"),
        JSON.stringify(keyJournal),
      );
      await copyFile(
        "drizzle/0002_breezy_proteus.sql",
        join(temporary, "0002_breezy_proteus.sql"),
      );
      await migrate(connection!.db, { migrationsFolder: temporary });
      const existingKeys = [
        {
          id: randomUUID(),
          token: "vlk_" + randomBytes(32).toString("base64url"),
          revoked: false,
        },
        {
          id: randomUUID(),
          token: "vlk_" + randomBytes(32).toString("base64url"),
          revoked: true,
        },
      ];
      for (const existing of existingKeys)
        await connection!.pool.query(
          "insert into api_keys (id, name, token_digest, token_hint, revoked_at) values ($1, 'Previous key name', $2, $3, case when $4 then statement_timestamp() else null end)",
          [
            existing.id,
            createHash("sha256").update(existing.token).digest("hex"),
            "vlk_…" + existing.token.slice(-4),
            existing.revoked,
          ],
        );
      const before = (
        await connection!.pool.query(
          "select id, token_digest, token_hint, created_at, expires_at, revoked_at from api_keys order by id",
        )
      ).rows;
      await migrateDatabase(url);
      assert.equal(await previous.ready(), true);
      assert.deepEqual(
        (await connection!.pool.query("select * from api_keys order by id"))
          .rows,
        before,
      );
      const upgradedKeys = new ApiKeys(connection!.db);
      for (const existing of existingKeys)
        assert.equal(
          await upgradedKeys.authorized("Bearer " + existing.token),
          !existing.revoked,
        );
      assert.equal(
        (
          await connection!.pool.query(
            "select count(*)::int count from information_schema.columns where table_schema='public' and table_name='api_keys' and column_name='name'",
          )
        ).rows[0].count,
        0,
      );
      await connection!.pool.query(
        "delete from api_keys where id = any($1::uuid[])",
        [existingKeys.map((existing) => existing.id)],
      );
      assert.deepEqual(
        object(
          (await previous.execute("health_get_record", { id: saved.id }))
            .record,
        ),
        saved,
      );
      assert.equal(
        (
          await connection!.pool.query(
            "select count(*)::int count from api_keys",
          )
        ).rows[0].count,
        0,
      );
    },
  );
  await start();
  await check(
    "API does not serve UI bundles or authentication HTML",
    async () => {
      const page = await fetch(baseUrl + "/api-keys", { redirect: "manual" });
      assert.equal(page.status, 404);
      assert.equal(page.headers.get("cache-control"), "no-store");
      assert.match(page.headers.get("content-type")!, /application\/json/);
      for (const path of [
        "/api-key-ui/assets/package.json",
        "/api-key-ui/assets/index.html",
        "/api-key-ui/assets/%2e%2e%2f%2e%2e%2fpackage.json",
      ]) {
        const missing = await fetch(baseUrl + path);
        assert.equal(missing.status, 404);
        await missing.text();
      }
    },
  );
  await check(
    "Root credentials issue a unique 30-day token while PostgreSQL stores only its hash",
    async () => {
      key = await create();
      assert.equal(
        Date.parse(String(key.expires_at)) - Date.parse(String(key.created_at)),
        30 * 24 * 60 * 60 * 1000,
      );
      const second = await create();
      assert.notEqual(key.api_key, second.api_key);
      assert.equal(key.status, "active");
      assert(!Object.hasOwn(key, "name"));
      const stored = (
        await connection!.pool.query("select * from api_keys where id=$1", [
          key.id,
        ])
      ).rows[0];
      assert.equal(
        stored.token_digest,
        createHash("sha256").update(String(key.api_key)).digest("hex"),
      );
      const raw = JSON.stringify(stored);
      for (const secret of [primary, rootPassword, key.api_key, second.api_key])
        assert(!raw.includes(String(secret)));
    },
  );
  await check(
    "Generated keys support REST reads, writes and the official MCP client",
    async () => {
      const token = String(key.api_key);
      assert.equal(
        (await request("/v1/catalog", "GET", undefined, token)).response.status,
        200,
      );
      assert.equal(
        (await request("/readyz", "GET", undefined, token)).response.status,
        200,
      );
      assert.equal(
        (await request("/openapi.json", "GET", undefined, token)).response
          .status,
        200,
      );
      const saved = await request(
        "/v1/measurements",
        "POST",
        { records: [examples.measurement] },
        token,
        { "Idempotency-Key": "generated-rest" },
      );
      assert.equal(saved.response.status, 200);
      const client = new Client({
        name: "vitalog-auth-test",
        version: "1.0.0",
      });
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(baseUrl + "/mcp"), {
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
          }),
        );
        assert.equal(
          (await client.listTools()).tools.length,
          operations.length,
        );
        const called = await client.callTool({
          name: "health_log_measurements",
          arguments: {
            records: [examples.measurement],
            idempotency_key: "generated-mcp",
          },
        });
        assert(!called.isError);
        const id = object(
          (object(called.structuredContent).records as unknown[])[0],
        ).id;
        assert.equal(
          (await request(`/v1/records/${id}`, "GET", undefined, primary))
            .response.status,
          200,
        );
      } finally {
        await client.close();
      }
    },
  );
  await check(
    "Only the primary AUTH_KEY can list or revoke generated keys",
    async () => {
      for (const [method, path] of [
        ["GET", "/v1/api-keys"],
        ["DELETE", `/v1/api-keys/${key.id}`],
        ["DELETE", "/v1/api-keys"],
      ]) {
        assert.equal(
          (await request(path!, method!, undefined, String(key.api_key)))
            .response.status,
          403,
        );
        assert.equal((await request(path!, method!)).response.status, 401);
      }
      const listed = await request(
        "/v1/api-keys?limit=1&offset=0",
        "GET",
        undefined,
        primary,
      );
      assert.equal(listed.response.status, 200);
      keyList.parse(listed.body);
      assert.equal((listed.body.api_keys as unknown[]).length, 1);
      assert.equal(listed.body.total, 2);
      for (const token of tokens) assert(!listed.text.includes(token));
      assert(!listed.text.includes("token_digest"));
      assert(!listed.text.includes("password"));
      for (const query of [
        "limit=101",
        "offset=-1",
        "limit=1&limit=2",
        "scope=admin",
      ])
        assert.equal(
          (await request("/v1/api-keys?" + query, "GET", undefined, primary))
            .response.status,
          422,
        );
    },
  );
  await check(
    "Restart, environment key rotation and a fresh MCP client preserve generated-key access",
    async () => {
      const previous = primary;
      primary = randomBytes(32).toString("base64url");
      await start();
      await denied(previous);
      assert.equal(
        (await request("/v1/catalog", "GET", undefined, String(key.api_key)))
          .response.status,
        200,
      );
      const client = new Client({
        name: "vitalog-auth-restart",
        version: "1.0.0",
      });
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(baseUrl + "/mcp"), {
            requestInit: {
              headers: { Authorization: `Bearer ${key.api_key}` },
            },
          }),
        );
        assert.equal(
          (await client.listTools()).tools.length,
          operations.length,
        );
      } finally {
        await client.close();
      }
    },
  );
  await check(
    "Unknown, malformed and duplicate generated authorization headers fail closed",
    async () => {
      await denied("vlk_" + randomBytes(32).toString("base64url"));
      await denied(String(key.api_key).slice(0, -1));
      const status = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          baseUrl + "/v1/catalog",
          {
            headers: {
              Authorization: [`Bearer ${key.api_key}`, `Bearer ${key.api_key}`],
            },
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
    },
  );
  await check(
    "Generated tokens and root passwords cannot be persisted or reflected in health data",
    async () => {
      for (const secret of [rootPassword, String(key.api_key)]) {
        const result = await request(
          "/v1/measurements",
          "POST",
          {
            records: [
              {
                ...examples.measurement,
                data: { ...examples.measurement.data, notes: secret },
              },
            ],
          },
          primary,
          { "Idempotency-Key": "guard-" + randomUUID() },
        );
        assert.equal(result.response.status, 422);
        assert(!result.text.includes(secret));
        const query = await request(
          "/v1/catalog?query=" + encodeURIComponent(secret),
          "GET",
          undefined,
          primary,
        );
        assert.equal(query.response.status, 422);
        assert(!query.text.includes(secret));
      }
    },
  );
  await check(
    "Individual revocation rejects REST and an already connected MCP client immediately",
    async () => {
      const client = new Client({
        name: "vitalog-auth-revoke",
        version: "1.0.0",
      });
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(baseUrl + "/mcp"), {
            requestInit: {
              headers: { Authorization: `Bearer ${key.api_key}` },
            },
          }),
        );
        const revoked = await request(
          `/v1/api-keys/${key.id}`,
          "DELETE",
          undefined,
          primary,
        );
        assert.equal(revoked.response.status, 200);
        keyMetadata.parse(revoked.body);
        assert.equal(revoked.body.status, "revoked");
        await denied(String(key.api_key));
        await assert.rejects(client.listTools());
        const again = await request(
          `/v1/api-keys/${key.id}`,
          "DELETE",
          undefined,
          primary,
        );
        assert.equal(again.body.revoked_at, revoked.body.revoked_at);
        assert.equal(
          (
            await request(
              `/v1/api-keys/${randomUUID()}`,
              "DELETE",
              undefined,
              primary,
            )
          ).response.status,
          404,
        );
      } finally {
        await client.close();
      }
    },
  );
  await start();
  await check(
    "Expired keys are rejected by both transports using the database clock",
    async () => {
      const expired = await create();
      await connection!.pool.query(
        "update api_keys set created_at=statement_timestamp()-interval '720 hours', expires_at=statement_timestamp() where id=$1",
        [expired.id],
      );
      await denied(String(expired.api_key));
      await denied(String(expired.api_key), "/mcp");
      const listed = await request("/v1/api-keys", "GET", undefined, primary);
      assert.equal(
        (listed.body.api_keys as Data[]).find((item) => item.id === expired.id)!
          .status,
        "expired",
      );
    },
  );
  await check(
    "Revoke-all invalidates every generated key while preserving the primary token",
    async () => {
      const first = await request("/v1/api-keys", "DELETE", undefined, primary);
      assert.equal(first.response.status, 200);
      assert.equal(first.body.revoked_count, 2);
      assert.equal(
        (await request("/v1/api-keys", "DELETE", undefined, primary)).body
          .revoked_count,
        0,
      );
      for (const token of tokens) await denied(token);
      assert.equal(
        (await request("/v1/catalog", "GET", undefined, primary)).response
          .status,
        200,
      );
      await start();
      for (const token of tokens) await denied(token);
      assert.equal((await create()).status, "active");
    },
  );
  await start();
  await check(
    "Invalid credentials, unknown fields and client-chosen expiry never issue keys",
    async () => {
      for (const body of [
        { ...credentials, password: "incorrect-password" },
        { ...credentials, email: "other@example.test" },
        { ...credentials, expires_at: "2099-01-01T00:00:00Z" },
        { ...credentials, name: "Removed field" },
        { ...credentials, [rootPassword]: "unknown" },
      ]) {
        const response = await request("/auth/api-keys", "POST", body);
        assert([401, 422].includes(response.response.status));
        assert(!response.text.includes(rootPassword));
      }
      await start();
      const oversized = await request("/auth/api-keys", "POST", {
        padding: "x".repeat(5000),
      });
      assert.equal(oversized.response.status, 413);
    },
  );
  await start();
  await check(
    "Credential issuance accepts the production same-origin page and rejects cross-origin submissions",
    async () => {
      assert.equal(
        (
          await request("/auth/api-keys", "POST", credentials, undefined, {
            Origin: "https://untrusted.example",
          })
        ).response.status,
        403,
      );
      const response = await new Promise<{ status: number; body: Data }>(
        (resolve, reject) => {
          const incoming = httpRequest(
            baseUrl + "/auth/api-keys",
            {
              method: "POST",
              headers: {
                Origin: "https://vitalog.praveent.com",
                Host: "vitalog.praveent.com",
                "Content-Type": "application/json",
              },
            },
            (result) => {
              let text = "";
              result.setEncoding("utf8");
              result.on("data", (chunk) => {
                text += chunk;
              });
              result.on("end", () =>
                resolve({
                  status: result.statusCode!,
                  body: object(JSON.parse(text)),
                }),
              );
            },
          );
          incoming.on("error", reject);
          incoming.end(JSON.stringify(credentials));
        },
      );
      assert.equal(response.status, 201);
      tokens.push(String(response.body.api_key));
      const encoded = await fetch(baseUrl + "/auth/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "email=root%40example.test&password=incorrect",
      });
      assert.equal(encoded.status, 422);
      await encoded.text();
    },
  );
  await start();
  await check(
    "Login attempts are bounded even when untrusted forwarded IP headers change",
    async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const response = await request(
          "/auth/api-keys",
          "POST",
          { ...credentials, password: "incorrect-password" },
          undefined,
          { "X-Forwarded-For": `192.0.2.${attempt + 1}` },
        );
        assert.equal(response.response.status, 401);
      }
      const blocked = await request("/auth/api-keys", "POST", credentials);
      assert.equal(blocked.response.status, 429);
      assert.equal(blocked.response.headers.get("retry-after"), "60");
      assert.equal(
        (await request("/v1/catalog", "GET", undefined, primary)).response
          .status,
        200,
      );
    },
  );
  await start();
  await check(
    "Concurrent password verification has a bounded memory and CPU budget",
    async () => {
      const responses = await Promise.all([
        createAttempt(),
        createAttempt(),
        createAttempt(),
      ]);
      assert.deepEqual(
        responses.map((response) => response.response.status).sort(),
        [201, 201, 429],
      );
      for (const response of responses)
        if (response.response.status === 201)
          tokens.push(String(response.body.api_key));
      async function createAttempt() {
        return request("/auth/api-keys", "POST", credentials);
      }
    },
  );
  await start(false);
  await check(
    "Unconfigured root credentials disable issuance without affecting primary or generated keys",
    async () => {
      assert.equal(
        (await request("/auth/api-keys", "POST", credentials)).response.status,
        503,
      );
      assert.equal(
        (await request("/v1/catalog", "GET", undefined, primary)).response
          .status,
        200,
      );
      assert.equal(
        (await request("/v1/catalog", "GET", undefined, tokens.at(-1)!))
          .response.status,
        200,
      );
    },
  );
  await check(
    "Request logs omit all credentials, tokens, bodies and key identifiers",
    async () => {
      const text = JSON.stringify(logs);
      for (const secret of [
        primary,
        rootPassword,
        rootEmail,
        databasePassword,
        ...tokens,
      ])
        assert(!text.includes(secret));
      assert(!text.includes(String(key.id)));
      assert(
        logs.every((entry) =>
          Object.keys(entry).every((name) =>
            ["event", "method", "status", "duration_ms"].includes(name),
          ),
        ),
      );
    },
  );
  await mkdir(".test-artifacts", { recursive: true });
  await writeFile(
    ".test-artifacts/auth.json",
    JSON.stringify(
      {
        result: "passed",
        checked_at: new Date().toISOString(),
        database: "PostgreSQL 17.11",
        transport: "REST and official Streamable HTTP MCP client",
        checks,
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(`PASS ${checks.length} API key authentication checks\n`);
} finally {
  await stop();
  await connection?.pool.end();
  if (temporary) await rm(temporary, { recursive: true, force: true });
  try {
    docker(["rm", "-f", "-v", container]);
  } catch {
    /* Startup may fail before the container exists. */
  }
}
