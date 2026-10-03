import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { assertionType } from "../src/auth/oauth-assertions.js";
import { mkdir, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  auth,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { application } from "../src/app.js";
import { configuration } from "../src/config.js";
import { database } from "../src/db/client.js";
import { Service } from "../src/service.js";
import { ApiKeys } from "../src/auth/keys.js";
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
const clientSecrets: string[] = [];
const docker = (args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
let connection: ReturnType<typeof database> | undefined;
let app: ReturnType<typeof application>;
let keys: ApiKeys;
const chatGptClientId = "https://chatgpt.com/oauth/client.json";
const chatGptRedirectUri =
  "https://chatgpt.com/connector_platform_oauth_redirect";
const alternateId = "https://alternate.example.test/oauth/client.json";
const alternateCallback = "https://alternate.example.test/callback";
const metadataFixtures = new Map<
  string,
  { body: string; cacheControl?: string }
>([
  [
    alternateId,
    {
      body: JSON.stringify({
        client_id: alternateId,
        client_name: "Alternate MCP client",
        redirect_uris: [alternateCallback],
        token_endpoint_auth_method: "none",
      }),
    },
  ],
]);
let metadataMode: "valid" | "wrong-callback" | "oversized" = "valid";
let clientFetches = 0;
const clientMetadataFetcher = async (input: string) => {
  if (metadataFixtures.has(input)) {
    clientFetches++;
    return metadataFixtures.get(input)!;
  }
  if (input === chatGptClientId) {
    clientFetches++;
    return {
      body: JSON.stringify({
        client_id: chatGptClientId,
        client_name: "ChatGPT",
        redirect_uris: [
          metadataMode === "wrong-callback"
            ? "https://untrusted.example/callback"
            : chatGptRedirectUri,
        ],
        token_endpoint_auth_method: "none",
        ...(metadataMode === "oversized" ? { padding: "x".repeat(9000) } : {}),
      }),
    };
  }
  throw new Error("Unknown metadata fixture");
};
function restart(
  rootConfigured = true,
  overrides: Record<string, string> = {},
) {
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
    ...overrides,
  });
  app = application(
    new Service(
      connection!.db,
      config.timezone,
      config.authDigest.toString("hex"),
    ),
    config,
    (entry) => logs.push(entry),
    { clientMetadataFetcher },
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
async function code(scope?: string, extras: Record<string, string> = {}) {
  const flow = await begin(scope, extras);
  const result = await approve(flow);
  assert.equal(result.response.status, 200);
  const redirect = new URL(String(result.body.redirect_to));
  const target = new URL(redirect);
  for (const parameter of ["code", "state", "iss"])
    target.searchParams.delete(parameter);
  assert.equal(target.href, new URL(flow.params.get("redirect_uri")!).href);
  assert.equal(redirect.searchParams.get("state"), flow.params.get("state"));
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
      client_id: grant.params.get("client_id")!,
      redirect_uri: grant.params.get("redirect_uri")!,
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
async function registerClient(metadata: Data) {
  const result = await json("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(metadata),
  });
  assert.equal(result.response.status, 201);
  if (result.body.client_secret)
    clientSecrets.push(String(result.body.client_secret));
  return result.body;
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
      for (const field of ["unexpected", "__proto__"]) {
        const params = new URLSearchParams(baseline);
        params.set(field, "value");
        const accepted = await request("/oauth/authorize?" + params);
        assert.equal(
          accepted.headers.get("location"),
          uiOrigin + "/oauth/authorize",
        );
      }
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
        await assert.rejects(
          () =>
            instance.callTool({
              name: "health_log_hydration",
              arguments: {
                ...examples.hydration,
                idempotency_key: randomBytes(16).toString("hex"),
              },
            }),
          (error: unknown) => {
            assert.equal(object(error).code, 403);
            return true;
          },
        );
        const denied = await request("/mcp", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + issued.access_token,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "health_log_hydration",
              arguments: examples.hydration,
            },
          }),
        });
        assert.equal(denied.status, 403);
        assert.match(
          denied.headers.get("www-authenticate")!,
          /scope="health:write"/,
        );
        assert.match(
          denied.headers.get("www-authenticate")!,
          /error="insufficient_scope"/,
        );
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
    "Approval attempts are bounded and token requests ignore extensions while rejecting unsupported grants and oversized bodies",
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
      for (const field of ["unused", "__proto__"]) {
        const accepted = await exchange(await code(), { [field]: "value" });
        assert.equal(accepted.response.status, 200);
        tokens.push(String(accepted.body.access_token));
      }
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
        assert.equal(response.status, 400);
        assert.equal(response.headers.get("location"), null);
        assert.equal(
          (await response.json()).error,
          mode === "wrong-callback" ? "invalid_request" : "invalid_client",
        );
      }
      metadataMode = "valid";
    },
  );
  await check(
    "A non-ChatGPT CIMD client owns its consent name, callback and code exchange",
    async () => {
      const flow = await begin("health:read", {
        client_id: alternateId,
        redirect_uri: alternateCallback,
        client_name: "Ignored impersonation",
      });
      const context = await json("/oauth/request", {
        headers: { Cookie: flow.cookie },
      });
      assert.equal(context.body.client_name, "Alternate MCP client");
      assert.equal(context.body.client_id, alternateId);
      assert.equal(context.body.redirect_uri, alternateCallback);
      const grant = await code("health:read", {
        client_id: alternateId,
        redirect_uri: alternateCallback,
      });
      assert.equal(
        (
          await exchange(grant, {
            client_id: chatGptClientId,
            redirect_uri: chatGptRedirectUri,
          })
        ).body.error,
        "invalid_grant",
      );
      assert.equal(
        (await exchange(grant, { redirect_uri: alternateCallback + "/other" }))
          .body.error,
        "invalid_grant",
      );
      const issued = await exchange(grant);
      assert.equal(issued.response.status, 200);
      tokens.push(String(issued.body.access_token));
      const instance = await client(String(issued.body.access_token));
      try {
        await instance.listTools();
        await instance.callTool({ name: "health_get_catalog", arguments: {} });
      } finally {
        await instance.close();
      }
      const bad = new URLSearchParams(flow.params);
      bad.set("redirect_uri", chatGptRedirectUri);
      const denied = await request("/oauth/authorize?" + bad);
      assert.equal(denied.status, 400);
      assert.equal(denied.headers.get("location"), null);
    },
  );
  await check(
    "CIMD caching is bounded per client, honors no-store, and never caches malformed metadata",
    async () => {
      const before = clientFetches;
      await begin();
      await begin();
      await begin("health:read", {
        client_id: alternateId,
        redirect_uri: alternateCallback,
      });
      assert.equal(clientFetches, before + 2);
      const id = "https://cache.example.test/client.json";
      const body = JSON.stringify({
        client_id: id,
        client_name: "Cache client",
        redirect_uris: [alternateCallback],
        token_endpoint_auth_method: "none",
      });
      metadataFixtures.set(id, { body, cacheControl: "no-store" });
      const start = clientFetches;
      await begin("health:read", {
        client_id: id,
        redirect_uri: alternateCallback,
      });
      await begin("health:read", {
        client_id: id,
        redirect_uri: alternateCallback,
      });
      assert.equal(clientFetches, start + 2);
      const invalidId = "https://invalid.example.test/client.json";
      metadataFixtures.set(invalidId, { body });
      const invalid = new URLSearchParams((await begin()).params);
      invalid.set("client_id", invalidId);
      invalid.set("redirect_uri", alternateCallback);
      const invalidStart = clientFetches;
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await request("/oauth/authorize?" + invalid);
        assert.equal(result.status, 400);
        assert.equal(result.headers.get("location"), null);
      }
      assert.equal(clientFetches, invalidStart + 2);
      metadataFixtures.delete(id);
      metadataFixtures.delete(invalidId);
    },
  );
  await check(
    "Dynamic public clients survive restart without receiving ledger access at registration",
    async () => {
      const before = (await keys.list(100, 0)).total;
      const registered = await registerClient({
        client_name: "MCP Inspector",
        redirect_uris: ["http://127.0.0.1:6274/oauth/callback"],
        token_endpoint_auth_method: "none",
      });
      assert.match(String(registered.client_id), /^vcl_[A-Za-z0-9_-]{43}$/);
      assert.equal(registered.client_secret, undefined);
      assert.equal((await keys.list(100, 0)).total, before);
      restart();
      const extras = {
        client_id: String(registered.client_id),
        redirect_uri: "http://127.0.0.1:49152/oauth/callback",
      };
      const flow = await begin("health:read", extras);
      assert.equal(
        (await json("/oauth/request", { headers: { Cookie: flow.cookie } }))
          .body.client_name,
        "MCP Inspector",
      );
      const grant = await code("health:read", extras);
      assert.equal(
        (
          await exchange(grant, {
            redirect_uri: "http://127.0.0.1:6274/oauth/callback",
          })
        ).body.error,
        "invalid_grant",
      );
      const issued = await exchange(grant);
      assert.equal(issued.response.status, 200);
      tokens.push(String(issued.body.access_token));
      const cancelled = await approve(
        await begin("health:read", extras),
        undefined,
        "deny",
      );
      const callback = new URL(String(cancelled.body.redirect_to));
      assert.equal(callback.host, "127.0.0.1:49152");
      assert.equal(callback.searchParams.get("error"), "access_denied");
    },
  );
  await check(
    "Registration retains application type, negotiates SDK grant capabilities and reclaims abandoned clients",
    async () => {
      const before = (await keys.list(100, 0)).total;
      const web = await registerClient({
        client_name: "Web client",
        application_type: "web",
        redirect_uris: [alternateCallback],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
      });
      assert.equal(web.application_type, "web");
      assert.deepEqual(web.grant_types, ["authorization_code"]);
      for (const redirect of [
        "http://127.0.0.1/callback",
        "https://localhost/callback",
        "com.example.client:/callback",
        "not-a-uri",
      ]) {
        const result = await json("/oauth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            application_type: "web",
            redirect_uris: [redirect],
            token_endpoint_auth_method: "none",
          }),
        });
        assert.equal(result.response.status, 400);
        assert.equal(result.body.error, "invalid_redirect_uri");
      }
      const native = await registerClient({
        client_name: "Native client",
        application_type: "native",
        redirect_uris: ["com.example.client:/callback"],
        token_endpoint_auth_method: "none",
      });
      assert.equal(native.application_type, "native");
      const nativeExtras = {
        client_id: String(native.client_id),
        redirect_uri: "com.example.client:/callback",
      };
      const nativeGrant = await code("health:read", nativeExtras);
      const nativeToken = await exchange(nativeGrant);
      assert.equal(nativeToken.response.status, 200);
      const expiredFlow = await begin("health:read", {
        client_id: String(web.client_id),
        redirect_uri: alternateCallback,
      });
      await connection!.pool.query(
        "update oauth_clients set created_at=statement_timestamp()-interval '61 minutes' where client_id=any($1)",
        [[String(web.client_id), String(native.client_id)]],
      );
      assert.equal(
        (await request("/oauth/authorize?" + expiredFlow.params)).status,
        400,
      );
      const failedApproval = await approve(expiredFlow, {
        ...login,
        password: "incorrect-password",
      });
      assert.equal(failedApproval.response.status, 401);
      assert.equal((await approve(expiredFlow)).response.status, 400);
      const available = await registerClient({
        client_name: "Replacement",
        redirect_uris: [alternateCallback],
        token_endpoint_auth_method: "none",
      });
      assert(available.client_id);
      assert.equal(
        (
          await connection!.pool.query(
            "select client_id from oauth_clients where client_id=$1",
            [String(web.client_id)],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await connection!.pool.query(
            "select approved_at from oauth_clients where client_id=$1",
            [String(native.client_id)],
          )
        ).rowCount,
        1,
      );
      restart();
      await begin("health:read", nativeExtras);
      const sdkClient = await client(String(nativeToken.body.access_token));
      try {
        assert.equal((await sdkClient.listTools()).tools.length, 16);
      } finally {
        await sdkClient.close();
      }
      assert.equal((await keys.list(100, 0)).total, before + 1);
    },
  );
  await check(
    "Confidential registrations hash secrets, enforce the declared authentication method and preserve code binding",
    async () => {
      for (const method of [
        "client_secret_basic",
        "client_secret_post",
      ] as const) {
        const registered = await registerClient({
          client_name: "Confidential client",
          redirect_uris: [alternateCallback],
          token_endpoint_auth_method: method,
        });
        const id = String(registered.client_id);
        const secret = String(registered.client_secret);
        assert.equal(registered.client_secret_expires_at, 0);
        const row = (
          await connection!.pool.query(
            "select * from oauth_clients where client_id=$1",
            [id],
          )
        ).rows[0];
        assert.equal(
          row.client_secret_digest,
          createHash("sha256").update(secret).digest("hex"),
        );
        assert(!JSON.stringify(row).includes(secret));
        const grant = await code(undefined, {
          client_id: id,
          redirect_uri: alternateCallback,
        });
        assert.equal((await exchange(grant)).response.status, 401);
        assert.equal(
          (await exchange(grant, { client_secret: "incorrect-client-secret" }))
            .response.status,
          401,
        );
        let issued: Awaited<ReturnType<typeof json>>;
        if (method === "client_secret_post")
          issued = await exchange(grant, { client_secret: secret });
        else {
          const form = new URLSearchParams({
            grant_type: "authorization_code",
            code: grant.code,
            redirect_uri: alternateCallback,
            resource: origin + "/mcp",
            code_verifier: grant.verifier,
          });
          const Authorization =
            "Basic " +
            Buffer.from(
              encodeURIComponent(id) + ":" + encodeURIComponent(secret),
            ).toString("base64");
          issued = await json("/oauth/token", {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Authorization,
            },
            body: form.toString(),
          });
        }
        assert.equal(issued.response.status, 200);
        tokens.push(String(issued.body.access_token));
        assert.equal((await request("/healthz?secret=" + secret)).status, 422);
        restart();
      }
    },
  );
  await check(
    "Configured clients support scopes, native callbacks and confidential secrets without exposing configuration",
    async () => {
      const secret = "vcs_" + randomBytes(32).toString("base64url");
      clientSecrets.push(secret);
      restart(true, {
        OAUTH_CLIENTS: JSON.stringify([
          {
            client_id: "configured-native",
            client_name: "Configured native client",
            redirect_uris: ["com.example.vitalog-client:/callback"],
            token_endpoint_auth_method: "client_secret_post",
            client_secret: secret,
            scope: "health:read",
          },
        ]),
      });
      const extras = {
        client_id: "configured-native",
        redirect_uri: "com.example.vitalog-client:/callback",
      };
      const grant = await code("health:read", extras);
      const issued = await exchange(grant, { client_secret: secret });
      assert.equal(issued.response.status, 200);
      tokens.push(String(issued.body.access_token));
      const params = new URLSearchParams(grant.params);
      params.set("scope", "health:write");
      const denied = await request("/oauth/authorize?" + params);
      assert.equal(denied.status, 302);
      assert.equal(
        new URL(denied.headers.get("location")!).searchParams.get("error"),
        "invalid_scope",
      );
      assert.equal((await request("/healthz?secret=" + secret)).status, 422);
      assert(
        !JSON.stringify(
          (await json("/.well-known/oauth-authorization-server")).body,
        ).includes(secret),
      );
    },
  );
  await check(
    "Optional state and canonical resource casing follow OAuth and native callback rules",
    async () => {
      const baseline = await begin("health:read", {
        client_id: alternateId,
        redirect_uri: alternateCallback,
      });
      const params = new URLSearchParams(baseline.params);
      params.delete("state");
      params.set("resource", "HTTP://127.0.0.1:3000/mcp");
      const response = await request("/oauth/authorize?" + params);
      assert.equal(response.status, 302);
      const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
      const context = await json("/oauth/request", {
        headers: { Cookie: cookie },
      });
      const allowed = await approve({
        ...baseline,
        cookie,
        csrf: String(context.body.csrf_token),
        params,
      });
      const callback = new URL(String(allowed.body.redirect_to));
      assert.equal(callback.searchParams.has("state"), false);
      assert.equal(callback.searchParams.get("iss"), origin);
      const issued = await exchange(
        { ...baseline, params, code: callback.searchParams.get("code")! },
        { resource: "HTTP://127.0.0.1:3000/mcp" },
      );
      assert.equal(issued.response.status, 200);
      tokens.push(String(issued.body.access_token));
    },
  );
  await check(
    "Explicit browser origins can discover and use OAuth while consent remains restricted to the UI",
    async () => {
      const browser = "http://localhost:6274";
      restart(true, { ALLOWED_ORIGINS: browser });
      const challenge = await request("/mcp", { headers: { Origin: browser } });
      assert.equal(challenge.status, 401);
      assert.equal(
        challenge.headers.get("access-control-allow-origin"),
        browser,
      );
      assert.match(
        challenge.headers.get("access-control-expose-headers")!,
        /WWW-Authenticate/,
      );
      for (const path of ["/mcp", "/oauth/register", "/oauth/token"]) {
        const result = await request(path, {
          method: "OPTIONS",
          headers: {
            Origin: browser,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers":
              "authorization, content-type, mcp-protocol-version",
          },
        });
        assert.equal(result.status, 204);
        assert.equal(
          result.headers.get("access-control-allow-credentials"),
          null,
        );
      }
      const denied = await request("/oauth/register", {
        method: "OPTIONS",
        headers: {
          Origin: "https://untrusted.example",
          "Access-Control-Request-Method": "POST",
        },
      });
      assert.equal(denied.status, 403);
      const flow = await begin();
      assert.equal(
        (
          await approve(flow, login, "allow", {
            headers: {
              Origin: browser,
              Cookie: flow.cookie,
              "Content-Type": "application/json",
            },
          })
        ).response.status,
        403,
      );
    },
  );
  await check(
    "The official MCP OAuth client completes CIMD and dynamic registration without ChatGPT assumptions",
    async () => {
      for (const discovery of ["cimd", "dcr"] as const) {
        const redirectUrl =
          discovery === "cimd"
            ? alternateCallback
            : "http://127.0.0.1:49153/callback";
        let information: OAuthClientInformationMixed | undefined;
        let saved: OAuthTokens | undefined;
        let verifier: string | undefined;
        let authorizationUrl: URL | undefined;
        const provider: OAuthClientProvider = {
          redirectUrl,
          ...(discovery === "cimd" ? { clientMetadataUrl: alternateId } : {}),
          clientMetadata: {
            client_name: "SDK MCP client",
            redirect_uris: [redirectUrl],
            token_endpoint_auth_method: "none",
          },
          state: () => randomBytes(32).toString("base64url"),
          clientInformation: () => information,
          saveClientInformation: (value) => {
            information = value;
          },
          tokens: () => saved,
          saveTokens: (value) => {
            saved = value;
          },
          redirectToAuthorization: (value) => {
            authorizationUrl = value;
          },
          saveCodeVerifier: (value) => {
            verifier = value;
          },
          codeVerifier: () => {
            assert(verifier);
            return verifier;
          },
        };
        const fetchFn = async (input: string | URL, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          headers.set("Host", new URL(input).host);
          return app.request(new Request(input, { ...init, headers }));
        };
        assert.equal(
          await auth(provider, { serverUrl: origin + "/mcp", fetchFn }),
          "REDIRECT",
        );
        assert(authorizationUrl);
        assert(information);
        assert.equal(information.client_id === chatGptClientId, false);
        const response = await request(
          authorizationUrl.pathname + authorizationUrl.search,
        );
        assert.equal(response.status, 302);
        const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
        const context = await json("/oauth/request", {
          headers: { Cookie: cookie },
        });
        const flow: Flow = {
          cookie,
          csrf: String(context.body.csrf_token),
          verifier: verifier!,
          state: authorizationUrl.searchParams.get("state")!,
          params: authorizationUrl.searchParams,
        };
        const approved = await approve(flow);
        assert.equal(approved.response.status, 200);
        const callback = new URL(String(approved.body.redirect_to));
        assert.equal(callback.searchParams.get("iss"), origin);
        assert.equal(
          await auth(provider, {
            serverUrl: origin + "/mcp",
            authorizationCode: callback.searchParams.get("code")!,
            fetchFn,
          }),
          "AUTHORIZED",
        );
        assert(saved);
        tokens.push(saved.access_token);
        const instance = new Client({
          name: "vitalog-standard-oauth-client",
          version: "1.0.0",
        });
        await instance.connect(
          new StreamableHTTPClientTransport(new URL(origin + "/mcp"), {
            authProvider: provider,
            fetch: fetchFn,
          }),
        );
        try {
          assert.equal((await instance.listTools()).tools.length, 16);
          await instance.callTool({
            name: "health_get_catalog",
            arguments: {},
          });
        } finally {
          await instance.close();
        }
      }
    },
  );
  await check(
    "Registration rejects invalid metadata and enforces its own rate limit",
    async () => {
      for (const body of [
        { redirect_uris: ["javascript:alert(1)"] },
        { redirect_uris: ["http://remote.example/callback"] },
        {
          redirect_uris: [alternateCallback],
          grant_types: ["client_credentials"],
        },
        {
          redirect_uris: [alternateCallback],
          token_endpoint_auth_method: "private_key_jwt",
        },
      ]) {
        const denied = await json("/oauth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        assert.equal(denied.response.status, 400);
        assert(!denied.body.client_id);
      }
      restart();
      for (let count = 0; count < 10; count++)
        await registerClient({
          client_name: "Rate-limited client",
          redirect_uris: [alternateCallback],
          token_endpoint_auth_method: "none",
        });
      const denied = await request("/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [alternateCallback] }),
      });
      assert.equal(denied.status, 429);
      assert.equal(denied.headers.get("retry-after"), "60");
    },
  );
  await check(
    "Private-key JWT clients verify public keys, issuer, audience, expiry and persistent replay protection",
    async () => {
      const pair = await generateKeyPair("RS256");
      const wrongPair = await generateKeyPair("RS256");
      const jwks = {
        keys: [
          {
            ...(await exportJWK(pair.publicKey)),
            kid: "signing-one",
            use: "sig",
            alg: "RS256",
          },
        ],
      };
      const id = "https://jwt.example.test/oauth/client.json";
      const jwksUrl = "https://jwt.example.test/oauth/jwks.json";
      const metadata = {
        client_id: id,
        client_name: "Signed MCP client",
        redirect_uris: [alternateCallback],
        token_endpoint_auth_method: "private_key_jwt",
        token_endpoint_auth_signing_alg: "RS256",
        jwks_uri: jwksUrl,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      };
      metadataFixtures.set(id, { body: JSON.stringify(metadata) });
      metadataFixtures.set(jwksUrl, { body: JSON.stringify(jwks) });
      const assertion = (
        claims: Data = {},
        key = pair.privateKey,
        algorithm = "RS256",
      ) =>
        new SignJWT({
          iss: id,
          sub: id,
          aud: origin + "/oauth/token",
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 120,
          jti: randomBytes(32).toString("base64url"),
          ...claims,
        })
          .setProtectedHeader({ alg: algorithm, kid: "signing-one" })
          .sign(key);
      const extras = { client_id: id, redirect_uri: alternateCallback };
      const grant = await code("health:read", extras);
      assert.equal((await exchange(grant)).response.status, 401);
      for (const claims of [
        { iss: alternateId },
        { sub: alternateId },
        { aud: "https://untrusted.example/token" },
        { exp: Math.floor(Date.now() / 1000) - 1 },
        { exp: Math.floor(Date.now() / 1000) + 3600 },
        { iat: Math.floor(Date.now() / 1000) + 30 },
        { jti: "" },
      ])
        assert.equal(
          (
            await exchange(grant, {
              client_assertion_type: assertionType,
              client_assertion: await assertion(claims),
            })
          ).response.status,
          401,
        );
      assert.equal(
        (
          await exchange(grant, {
            client_assertion_type: assertionType,
            client_assertion: await assertion({}, wrongPair.privateKey),
          })
        ).response.status,
        401,
      );
      const valid = await assertion();
      assert.equal(
        (await exchange(grant, { client_assertion: valid })).response.status,
        400,
      );
      assert.equal(
        (
          await exchange(grant, {
            client_assertion_type: assertionType,
            client_assertion: valid,
            client_secret: "wrong-secret",
          })
        ).response.status,
        400,
      );
      const issued = await exchange(grant, {
        client_assertion_type: assertionType,
        client_assertion: valid,
      });
      assert.equal(issued.response.status, 200);
      tokens.push(String(issued.body.access_token));
      restart();
      const second = await code("health:read", extras);
      assert.equal(
        (
          await exchange(second, {
            client_assertion_type: assertionType,
            client_assertion: valid,
          })
        ).response.status,
        401,
      );
      const sdkClient = await client(String(issued.body.access_token));
      try {
        assert.equal((await sdkClient.listTools()).tools.length, 16);
      } finally {
        await sdkClient.close();
      }
      for (const input of [
        { ...metadata, jwks_uri: "https://127.0.0.1/jwks.json" },
        {
          ...metadata,
          jwks_uri: undefined,
          jwks: { keys: [{ ...jwks.keys[0], d: "private-key" }] },
        },
      ]) {
        metadataFixtures.set(id, { body: JSON.stringify(input) });
        restart();
        assert.equal(
          (
            await request(
              "/oauth/authorize?" + new URLSearchParams(grant.params),
            )
          ).status,
          400,
        );
      }
      metadataFixtures.set(id, { body: JSON.stringify(metadata) });
      const registered = await registerClient({
        client_name: "Registered signed client",
        redirect_uris: [alternateCallback],
        token_endpoint_auth_method: "private_key_jwt",
        jwks,
      });
      assert.equal(registered.client_secret, undefined);
      const registeredId = String(registered.client_id);
      const registeredGrant = await code("health:read", {
        client_id: registeredId,
        redirect_uri: alternateCallback,
      });
      const signed = await assertion({
        iss: registeredId,
        sub: registeredId,
        aud: origin,
        iat: undefined,
      });
      assert.equal(
        (
          await exchange(registeredGrant, {
            client_id: alternateId,
            client_assertion_type: assertionType,
            client_assertion: signed,
          })
        ).response.status,
        401,
      );
      assert.equal(
        (
          await json("/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code: registeredGrant.code,
              redirect_uri: alternateCallback,
              resource: origin + "/mcp",
              code_verifier: registeredGrant.verifier,
              client_assertion_type: assertionType,
              client_assertion: signed,
            }),
          })
        ).response.status,
        200,
      );
      restart();
      const concurrent = await Promise.all([
        code("health:read", extras),
        code("health:read", extras),
      ]);
      const oneAssertion = await assertion();
      const results = await Promise.all(
        concurrent.map((grant) =>
          exchange(grant, {
            client_assertion_type: assertionType,
            client_assertion: oneAssertion,
          }),
        ),
      );
      assert.deepEqual(
        results.map((result) => result.response.status).sort(),
        [200, 401],
      );
      for (const algorithm of ["PS256", "ES256"] as const) {
        restart();
        const pair = await generateKeyPair(algorithm);
        const registered = await registerClient({
          client_name: "Signed client",
          redirect_uris: [alternateCallback],
          token_endpoint_auth_method: "private_key_jwt",
          token_endpoint_auth_signing_alg: algorithm,
          jwks: {
            keys: [
              {
                ...(await exportJWK(pair.publicKey)),
                alg: algorithm,
                kid: "one",
              },
            ],
          },
        });
        const id = String(registered.client_id);
        const grant = await code("health:read", {
          client_id: id,
          redirect_uri: alternateCallback,
        });
        const signed = await new SignJWT({
          iss: id,
          sub: id,
          aud: origin,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 120,
          jti: randomBytes(32).toString("base64url"),
        })
          .setProtectedHeader({ alg: algorithm, kid: "one" })
          .sign(pair.privateKey);
        assert.equal(
          (
            await exchange(grant, {
              client_assertion_type: assertionType,
              client_assertion: signed,
            })
          ).response.status,
          200,
        );
      }
      metadataFixtures.delete(id);
      metadataFixtures.delete(jwksUrl);
    },
  );
  await check(
    "Concurrent registrations share a persistent capacity limit and never overwrite clients",
    async () => {
      const before = (
        await connection!.pool.query(
          "select count(*)::int count from oauth_clients",
        )
      ).rows[0].count;
      const metadata = JSON.stringify({
        client_name: "Capacity fixture",
        redirect_uris: [alternateCallback],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
        scope: "health:read",
      });
      await connection!.pool.query(
        "insert into oauth_clients(client_id,metadata) select 'vcl_capacity'||lpad(n::text,35,'0'), $1::jsonb from generate_series(1,$2::int) n",
        [metadata, 999 - before],
      );
      try {
        const results = await Promise.all(
          [1, 2].map(() =>
            request("/oauth/register", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                redirect_uris: [alternateCallback],
                token_endpoint_auth_method: "none",
              }),
            }),
          ),
        );
        assert.deepEqual(
          results.map((value) => value.status).sort(),
          [201, 503],
        );
        assert.equal(
          (
            await connection!.pool.query(
              "select count(*)::int count from oauth_clients",
            )
          ).rows[0].count,
          1000,
        );
        assert.equal(
          (await request("/oauth/authorize?" + (await begin()).params)).status,
          302,
        );
        await connection!.pool.query(
          "update oauth_clients set created_at=statement_timestamp()-interval '61 minutes' where client_id like 'vcl_capacity%'",
        );
        assert(
          (
            await registerClient({
              redirect_uris: [alternateCallback],
              token_endpoint_auth_method: "none",
            })
          ).client_id,
        );
        assert.equal(
          (
            await connection!.pool.query(
              "select count(*)::int count from oauth_clients where client_id like 'vcl_capacity%'",
            )
          ).rows[0].count,
          0,
        );
        assert(
          (
            await connection!.pool.query(
              "select count(*)::int count from oauth_clients",
            )
          ).rows[0].count < 1000,
        );
      } finally {
        await connection!.pool.query(
          "delete from oauth_clients where client_id like 'vcl_capacity%'",
        );
      }
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
        ...clientSecrets,
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
          "deterministic CIMD fixtures plus official SDK discovery, registration, PKCE exchange and MCP calls",
        checks,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await connection?.pool.end();
  try {
    docker(["rm", "-f", container]);
  } catch {}
}
