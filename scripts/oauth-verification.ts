import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { application } from "../src/app.js";
import { configuration } from "../src/config.js";
import { database } from "../src/db/client.js";
import { Service } from "../src/service.js";
import { ApiKeys } from "../src/auth/keys.js";
import { chatGptClientId, chatGptRedirectUri } from "../src/auth/oauth.js";
import { pkceChallenge } from "../src/auth/oauth-store.js";
import { object, type Data } from "../src/domain/types.js";
import { examples } from "../tests/fixtures.js";
import { migrateDatabase } from "./migrate.js";

const container = `vitalog-oauth-${process.pid}`;
const databasePassword = randomBytes(32).toString("hex");
const primary = randomBytes(32).toString("base64url");
const origin = "http://127.0.0.1:3000";
const logs: Data[] = [];
const checks: { name: string; status: "passed" }[] = [];
const tokens: string[] = [];
const docker = (args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
let connection: ReturnType<typeof database> | undefined;
let app: ReturnType<typeof application>;
let keys: ApiKeys;
const nativeFetch = globalThis.fetch;
let metadataMode: "valid" | "wrong-callback" | "oversized" = "valid";
let clientFetches = 0;
globalThis.fetch = async (input, init) => {
  if (input === chatGptClientId) {
    clientFetches++;
    return Response.json({
      client_id: chatGptClientId,
      redirect_uris: [
        metadataMode === "wrong-callback"
          ? "https://untrusted.example/callback"
          : chatGptRedirectUri,
      ],
      token_endpoint_auth_methods_supported: ["none"],
      ...(metadataMode === "oversized" ? { padding: "x".repeat(9000) } : {}),
    });
  }
  return nativeFetch(input, init);
};
function restart() {
  const config = configuration({
    AUTH_KEY: primary,
    DATABASE_URL: connection!.pool.options.connectionString,
    PUBLIC_BASE_URL: origin,
    ALLOWED_HOSTS: new URL(origin).host,
    RATE_LIMIT_PER_MINUTE: "100000",
  });
  app = application(
    new Service(
      connection!.db,
      config.timezone,
      config.authDigest.toString("hex"),
    ),
    config,
    (entry) => logs.push(entry),
  );
}
async function request(path: string, init?: RequestInit) {
  return app.request(origin + path, init);
}
async function json(path: string, init?: RequestInit) {
  const response = await request(path, init);
  const text = await response.text();
  return { response, text, body: object(JSON.parse(text)) };
}
async function check(name: string, run: () => Promise<void>) {
  restart();
  await run();
  checks.push({ name, status: "passed" });
  process.stdout.write(`PASS ${name}\n`);
}
async function begin(
  scope = "health:read health:write",
  extras: Record<string, string> = {},
) {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: chatGptClientId,
    redirect_uri: chatGptRedirectUri,
    resource: origin + "/mcp",
    state,
    scope,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
    ...extras,
  });
  const response = await request("/oauth/authorize?" + params);
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  assert.match(response.headers.get("set-cookie")!, /HttpOnly/);
  assert.match(response.headers.get("set-cookie")!, /SameSite=Lax/);
  const context = await json("/oauth/request", { headers: { Cookie: cookie } });
  assert.equal(context.response.status, 200);
  return {
    cookie,
    csrf: String(context.body.csrf_token),
    verifier,
    state,
    params,
  };
}
type Flow = Awaited<ReturnType<typeof begin>>;
async function approve(
  flow: Flow,
  key?: string,
  action = "allow",
  extra: RequestInit = {},
) {
  return json("/oauth/approve", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      Cookie: flow.cookie,
      ...(key ? { Authorization: "Bearer " + key } : {}),
    },
    body: JSON.stringify({ csrf_token: flow.csrf, action }),
    ...extra,
  });
}
async function code(key: string, scope?: string) {
  const flow = await begin(scope);
  const result = await approve(flow, key);
  assert.equal(result.response.status, 200);
  const redirect = new URL(String(result.body.redirect_to));
  assert.equal(redirect.origin + redirect.pathname, chatGptRedirectUri);
  assert.equal(redirect.searchParams.get("state"), flow.state);
  assert.equal(redirect.searchParams.get("iss"), origin);
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  assert(!result.text.includes(key));
  return { ...flow, code: redirect.searchParams.get("code")! };
}
async function exchange(
  grant: Awaited<ReturnType<typeof code>>,
  extras: Record<string, string> = {},
) {
  return json("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: grant.code,
      client_id: chatGptClientId,
      redirect_uri: chatGptRedirectUri,
      resource: origin + "/mcp",
      code_verifier: grant.verifier,
      ...extras,
    }).toString(),
  });
}
async function token(key: string, scope?: string) {
  const issued = await exchange(await code(key, scope));
  assert.equal(issued.response.status, 200);
  assert.equal(issued.body.token_type, "Bearer");
  tokens.push(String(issued.body.access_token));
  return issued.body;
}
async function client(token: string) {
  const instance = new Client({
    name: "vitalog-oauth-verification",
    version: "1.0.0",
  });
  await instance.connect(
    new StreamableHTTPClientTransport(new URL(origin + "/mcp"), {
      requestInit: {
        headers: {
          Host: new URL(origin).host,
          Authorization: "Bearer " + token,
        },
      },
      fetch: async (input, init) => app.request(new Request(input, init)),
    }),
  );
  return instance;
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
  await migrateDatabase(url);
  keys = new ApiKeys(connection.db);
  const key = await keys.create();
  tokens.push(key.api_key);
  await check(
    "Discovery advertises S256, CIMD, issuer identification and the exact MCP audience",
    async () => {
      const metadata = (await json("/.well-known/oauth-protected-resource/mcp"))
        .body;
      const issuer = (await json("/.well-known/oauth-authorization-server"))
        .body;
      assert.equal(metadata.resource, origin + "/mcp");
      assert.deepEqual(metadata.authorization_servers, [issuer.issuer]);
      assert.deepEqual(issuer.code_challenge_methods_supported, ["S256"]);
      assert.equal(issuer.authorization_response_iss_parameter_supported, true);
      const denied = await request("/mcp");
      assert.equal(denied.status, 401);
      assert.match(
        denied.headers.get("www-authenticate")!,
        /oauth-protected-resource\/mcp/,
      );
    },
  );
  await check(
    "The approval page validates ChatGPT metadata and binds a private cookie to explicit consent",
    async () => {
      const before = clientFetches;
      const flow = await begin();
      assert.equal(clientFetches, before + 1);
      const request = await json("/oauth/request", {
        headers: { Cookie: flow.cookie },
      });
      assert.deepEqual(request.body.scopes, ["health:read", "health:write"]);
      assert.equal((await approve(flow, primary)).response.status, 401);
      assert.equal(
        (await approve(flow, "vlk_" + randomBytes(32).toString("base64url")))
          .response.status,
        401,
      );
      const cancelled = await approve(flow, undefined, "deny");
      assert.equal(cancelled.response.status, 200);
      const redirect = new URL(String(cancelled.body.redirect_to));
      assert.equal(redirect.searchParams.get("error"), "access_denied");
      assert.equal(redirect.searchParams.get("iss"), origin);
      assert.equal(redirect.searchParams.get("state"), flow.state);
      assert(!redirect.searchParams.has("code"));
    },
  );
  await check(
    "Untrusted identities stay local and trusted authorization errors return state and issuer to ChatGPT without fetching metadata",
    async () => {
      const baseline = (await begin()).params;
      const before = clientFetches;
      for (const [field, value] of [
        ["client_id", "http://169.254.169.254/latest/meta-data/"],
        ["redirect_uri", "https://untrusted.example/callback"],
      ]) {
        const params = new URLSearchParams(baseline);
        params.set(field!, value!);
        assert.equal((await request("/oauth/authorize?" + params)).status, 400);
      }
      for (const [field, value, error] of [
        ["resource", "https://untrusted.example/mcp", "invalid_target"],
        ["code_challenge_method", "plain", "invalid_request"],
        ["scope", "health:admin", "invalid_scope"],
        ["unexpected", "value", "invalid_request"],
      ]) {
        const params = new URLSearchParams(baseline);
        params.set(field!, value!);
        const response = await request("/oauth/authorize?" + params);
        assert.equal(response.status, 302);
        const redirect = new URL(response.headers.get("location")!);
        assert.equal(redirect.origin + redirect.pathname, chatGptRedirectUri);
        assert.equal(redirect.searchParams.get("error"), error);
        assert.equal(redirect.searchParams.get("state"), baseline.get("state"));
        assert.equal(redirect.searchParams.get("iss"), origin);
        assert(!redirect.searchParams.has("code"));
        assert.equal(response.headers.get("referrer-policy"), "no-referrer");
        assert.match(response.headers.get("set-cookie")!, /Max-Age=0/);
      }
      const duplicate = new URLSearchParams(baseline);
      duplicate.append("client_id", chatGptClientId);
      assert.equal(
        (await request("/oauth/authorize?" + duplicate)).status,
        400,
      );
      const duplicateResource = new URLSearchParams(baseline);
      duplicateResource.append("resource", origin + "/mcp");
      const invalid = await request("/oauth/authorize?" + duplicateResource);
      assert.equal(invalid.status, 302);
      const redirect = new URL(invalid.headers.get("location")!);
      assert.equal(redirect.searchParams.get("error"), "invalid_request");
      assert.equal(redirect.searchParams.get("state"), baseline.get("state"));
      assert.equal(redirect.searchParams.get("iss"), origin);
      assert.equal(clientFetches, before);
    },
  );
  await check(
    "Approval rejects absent or tampered cookies, mismatched CSRF and cross-origin requests",
    async () => {
      const flow = await begin();
      assert.equal(
        (
          await approve(flow, key.api_key, "allow", {
            body: JSON.stringify({
              csrf_token: randomBytes(32).toString("base64url"),
              action: "allow",
            }),
          })
        ).response.status,
        400,
      );
      for (const Cookie of [
        "",
        flow.cookie.slice(0, -1) + (flow.cookie.endsWith("A") ? "B" : "A"),
      ])
        assert.equal(
          (
            await approve(flow, key.api_key, "allow", {
              headers: {
                Origin: origin,
                "Content-Type": "application/json",
                Cookie,
                Authorization: "Bearer " + key.api_key,
              },
            })
          ).response.status,
          400,
        );
      assert.equal(
        (
          await approve(flow, key.api_key, "allow", {
            headers: {
              Origin: "https://untrusted.example",
              "Content-Type": "application/json",
              Cookie: flow.cookie,
              Authorization: "Bearer " + key.api_key,
            },
          })
        ).response.status,
        403,
      );
    },
  );
  await check(
    "A code is bound to its PKCE verifier, callback, client and resource and is exchanged only once",
    async () => {
      const grant = await code(key.api_key);
      const invalidExchanges: Record<string, string>[] = [
        { code_verifier: randomBytes(32).toString("base64url") },
        { resource: origin + "/other" },
        { redirect_uri: "https://untrusted.example/callback" },
        { client_id: "untrusted-client" },
      ];
      for (const extras of invalidExchanges)
        assert.equal((await exchange(grant, extras)).response.status, 400);
      const issued = await exchange(grant);
      assert.equal(issued.response.status, 200);
      tokens.push(String(issued.body.access_token));
      assert.equal((await exchange(grant)).body.error, "invalid_grant");
      const stored = (
        await connection!.pool.query("select * from oauth_access_tokens")
      ).rows;
      assert(
        stored.some(
          (row) =>
            row.token_digest ===
            createHash("sha256")
              .update(String(issued.body.access_token))
              .digest("hex"),
        ),
      );
      assert.equal(
        new Date(stored[0].expires_at).toISOString(),
        key.expires_at,
      );
      assert(
        Number(issued.body.expires_in) > 0 &&
          Number(issued.body.expires_in) <= 30 * 86400,
      );
      for (const secret of [
        primary,
        key.api_key,
        String(issued.body.access_token),
        grant.code,
      ]) {
        assert(!JSON.stringify(stored).includes(secret));
        assert(
          !JSON.stringify(
            (
              await connection!.pool.query(
                "select * from oauth_authorization_codes",
              )
            ).rows,
          ).includes(secret),
        );
      }
    },
  );
  await check(
    "Concurrent exchanges of one code issue exactly one access token",
    async () => {
      const grant = await code(key.api_key);
      const results = await Promise.all([exchange(grant), exchange(grant)]);
      assert.deepEqual(
        results.map((result) => result.response.status).sort(),
        [200, 400],
      );
      tokens.push(
        String(
          results.find((result) => result.response.status === 200)!.body
            .access_token,
        ),
      );
    },
  );
  await check(
    "OAuth tokens work with the official MCP client and do not grant REST or key-administration access",
    async () => {
      const issued = await token(key.api_key);
      const instance = await client(String(issued.access_token));
      try {
        const tools = await instance.listTools();
        assert.equal(tools.tools.length, 16);
        assert(
          tools.tools.every((tool) =>
            Array.isArray(tool._meta?.securitySchemes),
          ),
        );
        const discovery = await json("/mcp", {
          method: "POST",
          headers: {
            Host: new URL(origin).host,
            Authorization: "Bearer " + issued.access_token,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-11-25",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: {},
          }),
        });
        assert.equal(discovery.response.status, 200);
        const rawTools = object(discovery.body.result).tools;
        assert(Array.isArray(rawTools));
        for (const [name, scope] of [
          ["health_get_catalog", "health:read"],
          ["health_log_hydration", "health:write"],
        ]) {
          const tool = object(
            rawTools.find((value) => object(value).name === name),
          );
          assert.deepEqual(tool.securitySchemes, [
            { type: "oauth2", scopes: [scope] },
          ]);
          assert.deepEqual(
            object(tool._meta).securitySchemes,
            tool.securitySchemes,
          );
        }
        assert.equal(
          (
            await instance.callTool({
              name: "health_get_catalog",
              arguments: {},
            })
          ).isError,
          undefined,
        );
        assert.equal(
          (
            await instance.callTool({
              name: "health_log_hydration",
              arguments: {
                ...examples.hydration,
                idempotency_key: randomBytes(16).toString("hex"),
              },
            })
          ).isError,
          undefined,
        );
        for (const path of ["/v1/catalog", "/v1/api-keys", "/readyz"])
          assert.equal(
            (
              await request(path, {
                headers: { Authorization: "Bearer " + issued.access_token },
              })
            ).status,
            401,
          );
      } finally {
        await instance.close();
      }
    },
  );
  await check(
    "Read-only grants reject writes with the OAuth scope challenge and preserve data",
    async () => {
      const issued = await token(key.api_key, "health:read");
      const instance = await client(String(issued.access_token));
      try {
        const count = (
          await connection!.pool.query(
            "select count(*)::int count from health_records",
          )
        ).rows[0].count;
        assert.equal(
          (
            await instance.callTool({
              name: "health_get_catalog",
              arguments: {},
            })
          ).isError,
          undefined,
        );
        const rejected = await instance.callTool({
          name: "health_log_hydration",
          arguments: {
            ...examples.hydration,
            idempotency_key: randomBytes(16).toString("hex"),
          },
        });
        assert.equal(rejected.isError, true);
        assert(JSON.stringify(rejected._meta).includes("insufficient_scope"));
        assert.equal(
          (
            await connection!.pool.query(
              "select count(*)::int count from health_records",
            )
          ).rows[0].count,
          count,
        );
      } finally {
        await instance.close();
      }
    },
  );
  await check(
    "OAuth access survives a server restart and parent-key revocation blocks an already connected client",
    async () => {
      const parent = await keys.create();
      const issued = await token(parent.api_key);
      restart();
      const instance = await client(String(issued.access_token));
      try {
        await instance.listTools();
        await keys.revoke(parent.id);
        await assert.rejects(() => instance.listTools());
      } finally {
        await instance.close();
      }
    },
  );
  await check(
    "Expired authorization codes and expired or revoked parent keys cannot issue or use tokens",
    async () => {
      const parent = await keys.create();
      const grant = await code(parent.api_key);
      await connection!.pool.query(
        "update oauth_authorization_codes set created_at=statement_timestamp()-interval '300 seconds', expires_at=statement_timestamp() where code_digest=$1",
        [createHash("sha256").update(grant.code).digest("hex")],
      );
      assert.equal((await exchange(grant)).body.error, "invalid_grant");
      const issued = await token(parent.api_key);
      const pending = await code(parent.api_key);
      await connection!.pool.query(
        "update api_keys set created_at=statement_timestamp()-interval '720 hours', expires_at=statement_timestamp() where id=$1",
        [parent.id],
      );
      assert.equal((await exchange(pending)).body.error, "invalid_grant");
      assert.equal(
        (
          await request("/mcp", {
            headers: { Authorization: "Bearer " + issued.access_token },
          })
        ).status,
        401,
      );
      const revoked = await keys.create();
      const revokedGrant = await code(revoked.api_key);
      await keys.revoke(revoked.id);
      assert.equal((await exchange(revokedGrant)).body.error, "invalid_grant");
    },
  );
  await check(
    "Expired and revoked OAuth grants are pruned in bounded shared batches without deleting active grants, keys or ledger records",
    async () => {
      const parent = await keys.create();
      const active = await token(parent.api_key);
      const pending = await code(parent.api_key);
      const revoked = await keys.create();
      const revokedAccess = await token(revoked.api_key);
      const revokedCode = await code(revoked.api_key);
      await keys.revoke(revoked.id);
      const ledgerCount = (
        await connection!.pool.query(
          "select count(*)::int count from health_records",
        )
      ).rows[0].count;
      await connection!.pool.query(
        `
        insert into oauth_authorization_codes (
          code_digest, api_key_id, client_id, redirect_uri, resource, scopes, code_challenge, created_at, expires_at
        ) select lpad(n::text, 64, '0'), $1, $2, $3, $4, array['health:read'], $5,
          statement_timestamp()-interval '900 seconds', statement_timestamp()-interval '600 seconds'
        from generate_series(1,1500) n
      `,
        [
          parent.id,
          chatGptClientId,
          chatGptRedirectUri,
          origin + "/mcp",
          "c".repeat(43),
        ],
      );
      const expiredDigest = "0".repeat(64);
      await connection!.pool.query(
        `
        insert into oauth_access_tokens (token_digest, api_key_id, resource, scopes, created_at, expires_at)
        values ($1, $2, $3, array['health:read'], statement_timestamp()-interval '120 seconds', statement_timestamp()-interval '60 seconds')
      `,
        [expiredDigest, parent.id, origin + "/mcp"],
      );
      const staleCount = async () =>
        (
          await connection!.pool.query(
            "select count(*)::int count from oauth_authorization_codes where code_digest like $1",
            ["0".repeat(48) + "%"],
          )
        ).rows[0].count;
      const denied = () =>
        request("/mcp", {
          headers: { Authorization: "Bearer vlo_" + "x".repeat(43) },
        });
      restart();
      assert.deepEqual(
        (await Promise.all([denied(), denied()])).map(
          (response) => response.status,
        ),
        [401, 401],
      );
      assert.equal(await staleCount(), 500);
      await denied();
      assert.equal(await staleCount(), 500);
      restart();
      await denied();
      assert.equal(await staleCount(), 0);
      const digest = (value: string) =>
        createHash("sha256").update(value).digest("hex");
      assert.equal(
        (
          await connection!.pool.query(
            "select count(*)::int count from oauth_access_tokens where token_digest=any($1)",
            [[expiredDigest, digest(String(revokedAccess.access_token))]],
          )
        ).rows[0].count,
        0,
      );
      assert.equal(
        (
          await connection!.pool.query(
            "select count(*)::int count from oauth_authorization_codes where code_digest=$1",
            [digest(revokedCode.code)],
          )
        ).rows[0].count,
        0,
      );
      assert.equal(
        (
          await connection!.pool.query(
            "select count(*)::int count from api_keys where id=any($1)",
            [[parent.id, revoked.id]],
          )
        ).rows[0].count,
        2,
      );
      assert.equal(
        (
          await connection!.pool.query(
            "select count(*)::int count from health_records",
          )
        ).rows[0].count,
        ledgerCount,
      );
      const instance = await client(String(active.access_token));
      try {
        await instance.listTools();
      } finally {
        await instance.close();
      }
      const exchanged = await exchange(pending);
      assert.equal(exchanged.response.status, 200);
      tokens.push(String(exchanged.body.access_token));
    },
  );
  await check(
    "Revoke-all invalidates every OAuth connection and credentials cannot enter health data or URLs",
    async () => {
      const issued = await token(key.api_key);
      const instance = await client(String(issued.access_token));
      try {
        await assert.rejects(
          () =>
            instance.callTool({
              name: "health_log_hydration",
              arguments: {
                ...examples.hydration,
                data: {
                  ...examples.hydration.data,
                  notes: issued.access_token,
                },
                idempotency_key: randomBytes(16).toString("hex"),
              },
            }),
          (error: unknown) => {
            assert.equal(object(error).code, 422);
            assert(!String(error).includes(String(issued.access_token)));
            return true;
          },
        );
        assert.equal(
          (await request("/healthz?token=" + issued.access_token)).status,
          422,
        );
        await keys.revokeAll();
        await assert.rejects(() => instance.listTools());
      } finally {
        await instance.close();
      }
    },
  );
  await check(
    "Approval attempts are bounded and token requests reject unknown parameters, client credentials and oversized bodies",
    async () => {
      const flow = await begin();
      for (let attempt = 0; attempt < 5; attempt++)
        assert.equal(
          (await approve(flow, "vlk_" + randomBytes(32).toString("base64url")))
            .response.status,
          401,
        );
      const limited = await approve(
        flow,
        "vlk_" + randomBytes(32).toString("base64url"),
      );
      assert.equal(limited.response.status, 429);
      assert.equal(limited.response.headers.get("retry-after"), "60");
      const parent = await keys.create();
      restart();
      const grant = await code(parent.api_key);
      assert.equal(
        (await exchange(grant, { client_secret: primary })).response.status,
        422,
      );
      assert.equal(
        (await exchange(grant, { unused: "value" })).response.status,
        400,
      );
      assert.equal(
        (
          await request("/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "padding=" + "x".repeat(5000),
          })
        ).status,
        413,
      );
    },
  );
  await check(
    "Incompatible and oversized ChatGPT metadata fail closed without trusting another callback",
    async () => {
      for (const mode of ["wrong-callback", "oversized"] as const) {
        metadataMode = mode;
        restart();
        const params = new URLSearchParams({
          response_type: "code",
          client_id: chatGptClientId,
          redirect_uri: chatGptRedirectUri,
          resource: origin + "/mcp",
          state: "synthetic-state",
          code_challenge: pkceChallenge(randomBytes(32).toString("base64url")),
          code_challenge_method: "S256",
        });
        const response = await request("/oauth/authorize?" + params);
        assert.equal(response.status, 302);
        const redirect = new URL(response.headers.get("location")!);
        assert.equal(redirect.origin + redirect.pathname, chatGptRedirectUri);
        assert.equal(
          redirect.searchParams.get("error"),
          "temporarily_unavailable",
        );
        assert.equal(redirect.searchParams.get("state"), "synthetic-state");
        assert.equal(redirect.searchParams.get("iss"), origin);
        assert(!redirect.searchParams.has("code"));
      }
      metadataMode = "valid";
    },
  );
  await check(
    "Request logs contain no credentials, OAuth codes, cookies or sensitive parameters",
    async () => {
      const serialized = JSON.stringify(logs);
      for (const secret of [primary, databasePassword, ...tokens])
        assert(!serialized.includes(secret));
      assert(
        logs.every((entry) =>
          Object.keys(entry).every((key) =>
            ["event", "method", "status", "duration_ms"].includes(key),
          ),
        ),
      );
    },
  );
  await mkdir(".test-artifacts", { recursive: true });
  await writeFile(
    ".test-artifacts/oauth.json",
    JSON.stringify(
      {
        status: "passed",
        database: "disposable-postgresql-17",
        client_metadata:
          "deterministic fixture matching the published ChatGPT CIMD contract",
        checks,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  globalThis.fetch = nativeFetch;
  await connection?.pool.end();
  try {
    docker(["rm", "-f", container]);
  } catch {}
}
