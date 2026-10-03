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
import { OAuthStore, pkceChallenge } from "../src/auth/oauth-store.js";
import { object, type Data } from "../src/domain/types.js";
import { examples } from "../tests/fixtures.js";
import { migrateDatabase } from "./migrate.js";

const container = `vitalog-oauth-${process.pid}`;
const databasePassword = randomBytes(32).toString("hex");
const primary = randomBytes(32).toString("base64url");
const login = {
  email: "oauth.owner@example.test",
  password: randomBytes(32).toString("base64url"),
};
const origin = "http://127.0.0.1:3000";
const uiOrigin = "http://127.0.0.1:3001";
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
function restart(rootConfigured = true) {
  const config = configuration({
    AUTH_KEY: primary,
    DATABASE_URL: connection!.pool.options.connectionString,
    PUBLIC_BASE_URL: origin,
    UI_BASE_URL: uiOrigin,
    ALLOWED_HOSTS: new URL(origin).host,
    RATE_LIMIT_PER_MINUTE: "100000",
    ...(rootConfigured
      ? { ROOT_EMAIL: login.email, ROOT_PASSWORD: login.password }
      : {}),
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
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), uiOrigin + "/oauth/authorize");
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
  credentials: typeof login | undefined = login,
  action = "allow",
  extra: RequestInit = {},
) {
  return json("/oauth/approve", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: uiOrigin,
      Cookie: flow.cookie,
    },
    body: JSON.stringify({
      csrf_token: flow.csrf,
      action,
      ...(action === "allow" ? credentials : {}),
    }),
    ...extra,
  });
}
async function code(scope?: string) {
  const flow = await begin(scope);
  const result = await approve(flow);
  assert.equal(result.response.status, 200);
  const redirect = new URL(String(result.body.redirect_to));
  assert.equal(redirect.origin + redirect.pathname, chatGptRedirectUri);
  assert.equal(redirect.searchParams.get("state"), flow.state);
  assert.equal(redirect.searchParams.get("iss"), origin);
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  assert(!result.text.includes(login.password));
  assert(!result.text.includes(login.email));
  return { ...flow, code: redirect.searchParams.get("code")! };
}
async function legacyCode(apiKeyId: string, scope?: string) {
  const flow = await begin(scope);
  const store = new OAuthStore(connection!.db, origin + "/mcp");
  const issued = await store.issueCode(apiKeyId, {
    client_id: chatGptClientId,
    redirect_uri: chatGptRedirectUri,
    resource: origin + "/mcp",
    scopes: (scope ?? "health:read health:write").split(" "),
    code_challenge: pkceChallenge(flow.verifier),
  });
  return { ...flow, code: issued };
}
async function connectionKey(token: string) {
  const result = await connection!.pool.query<{
    id: string;
    token_digest: string;
    token_hint: string;
    created_at: Date;
    expires_at: Date;
  }>(
    "select k.* from api_keys k join oauth_access_tokens g on g.api_key_id=k.id where g.token_digest=$1",
    [createHash("sha256").update(token).digest("hex")],
  );
  assert.equal(result.rowCount, 1);
  const row = result.rows[0]!;
  return {
    ...row,
    created_at: row.created_at.toISOString(),
    expires_at: row.expires_at.toISOString(),
  };
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
async function token(scope?: string) {
  const issued = await exchange(await code(scope));
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
      for (const supplied of [primary, key.api_key])
        assert.equal(
          (
            await approve(flow, undefined, "allow", {
              headers: {
                "Content-Type": "application/json",
                Origin: uiOrigin,
                Cookie: flow.cookie,
                Authorization: "Bearer " + supplied,
              },
              body: JSON.stringify({ csrf_token: flow.csrf, action: "allow" }),
            })
          ).response.status,
          400,
        );
      assert.equal(
        (await approve(flow, { ...login, password: "incorrect-password" }))
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
    "Root sign-in returns only a code; exchange creates one managed 30-day MCP token without a pre-generated API key",
    async () => {
      const before = (await keys.list(100, 0)).total;
      const grant = await code();
      assert.equal((await keys.list(100, 0)).total, before);
      const pending = (
        await connection!.pool.query(
          "select api_key_id, consumed_at from oauth_authorization_codes where code_digest=$1",
          [createHash("sha256").update(grant.code).digest("hex")],
        )
      ).rows[0];
      assert.equal(pending.api_key_id, null);
      assert.equal(pending.consumed_at, null);
      const issued = await exchange(grant);
      assert.equal(issued.response.status, 200);
      assert.match(String(issued.body.access_token), /^vlo_[A-Za-z0-9_-]{43}$/);
      assert.equal(issued.body.token_type, "Bearer");
      assert.equal(issued.body.scope, "health:read health:write");
      tokens.push(String(issued.body.access_token));
      const parent = await connectionKey(String(issued.body.access_token));
      assert.equal(
        parent.token_digest,
        createHash("sha256")
          .update(String(issued.body.access_token))
          .digest("hex"),
      );
      assert.equal(
        new Date(String(parent.expires_at)).getTime() -
          new Date(String(parent.created_at)).getTime(),
        30 * 86400 * 1000,
      );
      assert.match(String(parent.token_hint), /^vlo_…/);
      const listed = await json("/v1/api-keys", {
        headers: { Authorization: "Bearer " + primary },
      });
      assert.equal(listed.response.status, 200);
      assert.equal(listed.body.total, before + 1);
      assert(Array.isArray(listed.body.api_keys));
      assert(
        listed.body.api_keys.some((value) => object(value).id === parent.id),
      );
      for (const secret of [
        login.email,
        login.password,
        String(issued.body.access_token),
        String(parent.token_digest),
      ])
        assert(!listed.text.includes(secret));
    },
  );
  await check(
    "Root sign-in fails closed when unconfigured, rejects malformed credentials and does not create keys on failure or cancellation",
    async () => {
      const before = (await keys.list(100, 0)).total;
      const flow = await begin();
      for (const credentials of [
        { ...login, email: "different.owner@example.test" },
        { ...login, password: "incorrect-password" },
      ])
        assert.equal((await approve(flow, credentials)).response.status, 401);
      for (const body of [
        { csrf_token: flow.csrf, action: "allow", ...login, name: "unused" },
        { csrf_token: flow.csrf, action: "allow", email: login.email },
      ])
        assert.equal(
          (await approve(flow, login, "allow", { body: JSON.stringify(body) }))
            .response.status,
          400,
        );
      restart(false);
      const unconfigured = await begin();
      assert.equal((await approve(unconfigured)).response.status, 503);
      assert.equal(
        (await approve(unconfigured, undefined, "deny")).response.status,
        200,
      );
      assert.equal((await keys.list(100, 0)).total, before);
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
        ["__proto__", "value", "invalid_request"],
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
          await approve(flow, login, "allow", {
            body: JSON.stringify({
              csrf_token: randomBytes(32).toString("base64url"),
              action: "allow",
              ...login,
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
            await approve(flow, login, "allow", {
              headers: {
                Origin: uiOrigin,
                "Content-Type": "application/json",
                Cookie,
              },
            })
          ).response.status,
          400,
        );
      assert.equal(
        (
          await approve(flow, login, "allow", {
            headers: {
              Origin: "https://untrusted.example",
              "Content-Type": "application/json",
              Cookie: flow.cookie,
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
      const grant = await code();
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
      const storedToken = stored.find(
        (row) =>
          row.token_digest ===
          createHash("sha256")
            .update(String(issued.body.access_token))
            .digest("hex"),
      );
      assert(storedToken);
      assert.equal(
        new Date(storedToken.expires_at).toISOString(),
        new Date(
          String(
            (await connectionKey(String(issued.body.access_token))).expires_at,
          ),
        ).toISOString(),
      );
      assert(
        Number(issued.body.expires_in) > 0 &&
          Number(issued.body.expires_in) <= 30 * 86400,
      );
      for (const secret of [
        primary,
        key.api_key,
        login.password,
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
    "A failed token insert rolls back key creation and code consumption so the exchange can be retried",
    async () => {
      const grant = await code();
      const before = (await keys.list(100, 0)).total;
      await connection!.pool.query(`
        create function test_fail_oauth_token() returns trigger language plpgsql as $$
        begin raise exception 'Synthetic token insert failure'; end;
        $$
      `);
      await connection!.pool.query(
        "create trigger test_fail_oauth_token before insert on oauth_access_tokens for each row execute function test_fail_oauth_token()",
      );
      try {
        assert.equal((await exchange(grant)).response.status, 500);
        assert.equal((await keys.list(100, 0)).total, before);
        const pending = (
          await connection!.pool.query(
            "select api_key_id, consumed_at from oauth_authorization_codes where code_digest=$1",
            [createHash("sha256").update(grant.code).digest("hex")],
          )
        ).rows[0];
        assert.equal(pending.api_key_id, null);
        assert.equal(pending.consumed_at, null);
      } finally {
        await connection!.pool.query(
          "drop trigger test_fail_oauth_token on oauth_access_tokens",
        );
        await connection!.pool.query("drop function test_fail_oauth_token()");
      }
      const retried = await exchange(grant);
      assert.equal(retried.response.status, 200);
      assert.equal((await keys.list(100, 0)).total, before + 1);
      tokens.push(String(retried.body.access_token));
    },
  );
  await check(
    "Concurrent exchanges of one code issue exactly one access token",
    async () => {
      const before = (await keys.list(100, 0)).total;
      const grant = await code();
      const results = await Promise.all([exchange(grant), exchange(grant)]);
      assert.deepEqual(
        results.map((result) => result.response.status).sort(),
        [200, 400],
      );
      assert.equal((await keys.list(100, 0)).total, before + 1);
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
      const issued = await token();
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
      const issued = await token("health:read");
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
    "OAuth access survives a restart and the primary key can revoke its management record to disconnect a client",
    async () => {
      const issued = await token();
      const parent = await connectionKey(String(issued.access_token));
      restart();
      const instance = await client(String(issued.access_token));
      try {
        await instance.listTools();
        assert.equal(
          (
            await request("/v1/api-keys/" + parent.id, {
              method: "DELETE",
              headers: { Authorization: "Bearer " + primary },
            })
          ).status,
          200,
        );
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
      const grant = await code();
      await connection!.pool.query(
        "update oauth_authorization_codes set created_at=statement_timestamp()-interval '300 seconds', expires_at=statement_timestamp() where code_digest=$1",
        [createHash("sha256").update(grant.code).digest("hex")],
      );
      assert.equal((await exchange(grant)).body.error, "invalid_grant");
      const issued = await exchange(await legacyCode(parent.id));
      assert.equal(issued.response.status, 200);
      tokens.push(String(issued.body.access_token));
      const pending = await legacyCode(parent.id);
      await connection!.pool.query(
        "update api_keys set created_at=statement_timestamp()-interval '720 hours', expires_at=statement_timestamp() where id=$1",
        [parent.id],
      );
      assert.equal((await exchange(pending)).body.error, "invalid_grant");
      assert.equal(
        (
          await request("/mcp", {
            headers: { Authorization: "Bearer " + issued.body.access_token },
          })
        ).status,
        401,
      );
      const revoked = await keys.create();
      const revokedGrant = await legacyCode(revoked.id);
      await keys.revoke(revoked.id);
      assert.equal((await exchange(revokedGrant)).body.error, "invalid_grant");
    },
  );
  await check(
    "Expired and revoked OAuth grants are pruned in bounded shared batches without deleting active grants, keys or ledger records",
    async () => {
      const parent = await keys.create();
      const active = await exchange(await legacyCode(parent.id));
      assert.equal(active.response.status, 200);
      tokens.push(String(active.body.access_token));
      const pending = await code();
      const revoked = await keys.create();
      const revokedAccess = await exchange(await legacyCode(revoked.id));
      assert.equal(revokedAccess.response.status, 200);
      tokens.push(String(revokedAccess.body.access_token));
      const revokedCode = await legacyCode(revoked.id);
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
          null,
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
            [[expiredDigest, digest(String(revokedAccess.body.access_token))]],
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
      const instance = await client(String(active.body.access_token));
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
      const issued = await token();
      const pending = await code();
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
        assert.equal(
          (
            await request("/v1/api-keys", {
              method: "DELETE",
              headers: { Authorization: "Bearer " + primary },
            })
          ).status,
          200,
        );
        assert.equal((await exchange(pending)).body.error, "invalid_grant");
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
          (await approve(flow, { ...login, password: "incorrect-password" }))
            .response.status,
          401,
        );
      const limited = await approve(flow, {
        ...login,
        password: "incorrect-password",
      });
      assert.equal(limited.response.status, 429);
      assert.equal(limited.response.headers.get("retry-after"), "60");
      restart();
      const grant = await code();
      assert.equal(
        (await exchange(grant, { client_secret: primary })).response.status,
        422,
      );
      assert.equal(
        (await exchange(grant, { unused: "value" })).response.status,
        400,
      );
      assert.equal(
        (await exchange(grant, { ["__proto__"]: "value" })).response.status,
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
    "Root sign-in shares its attempt budget across API-key creation and OAuth and passwords cannot enter URLs",
    async () => {
      const flow = await begin();
      assert.equal(
        (
          await request("/oauth/approve?password=" + login.password, {
            method: "POST",
            headers: {
              Origin: uiOrigin,
              Cookie: flow.cookie,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              csrf_token: flow.csrf,
              action: "allow",
              ...login,
            }),
          })
        ).status,
        422,
      );
      restart();
      assert.equal(
        (
          await request("/auth/api-keys", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...login, password: "incorrect-password" }),
          })
        ).status,
        401,
      );
      for (let attempt = 0; attempt < 4; attempt++)
        assert.equal(
          (await approve(flow, { ...login, password: "incorrect-password" }))
            .response.status,
          401,
        );
      const limited = await approve(flow);
      assert.equal(limited.response.status, 429);
      assert.equal(limited.response.headers.get("retry-after"), "60");
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
      for (const secret of [
        primary,
        databasePassword,
        login.email,
        login.password,
        ...tokens,
      ])
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
