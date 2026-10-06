import type { HttpBindings } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { timeout } from "hono/timeout";
import { HTTPException } from "hono/http-exception";
import { authorized, type Config } from "./config.js";
import { DomainError, publicError } from "./errors.js";
import { handleMcp } from "./mcp.js";
import { openapi } from "./openapi.js";
import { operations } from "./registry/operations.js";
import type { Service } from "./service.js";
import type { Data } from "./domain/types.js";
import { inspectBody, MAX_REQUEST_BYTES } from "./security.js";
import { MAX_RESPONSE_BYTES } from "./domain/catalog.js";
import { ApiKeys } from "./auth/keys.js";
import { RootAuthentication } from "./auth/root.js";
import { RootAccount } from "./auth/account.js";
import { profileSchema, preferencesSchema } from "./auth/account-contracts.js";
import { BrowserSessions } from "./auth/sessions.js";
import { KeyManagementSessions } from "./auth/key-management.js";
import { localDate } from "./domain/validation.js";
import { keyCreation, keyId, keyListQuery } from "./auth/contracts.js";
import { OAuthStore } from "./auth/oauth-store.js";
import { oauthChallenge, oauthRoutes } from "./auth/oauth.js";
import {
  OAuthClients,
  type ClientMetadataFetcher,
} from "./auth/oauth-clients.js";

const deadlineMessage =
  "Request exceeded its deadline; mutations may be retried with the same idempotency key";
type AppEnvironment = {
  Bindings: HttpBindings;
  Variables: {
    oauthScopes?: string[];
    browserSession?: { id: string; expiresAt: Date };
    keyManagementSession?: { id: string; expiresAt: Date };
  };
};

export function application(
  service: Service,
  config: Config,
  log = (entry: Data) => {
    process.stdout.write(JSON.stringify(entry) + "\n");
  },
  dependencies: { clientMetadataFetcher?: ClientMetadataFetcher } = {},
) {
  const app = new Hono<AppEnvironment>();
  const limits = new Map<string, { count: number; reset: number }>();
  const registrationLimits = new Map<
    string,
    { count: number; reset: number }
  >();
  const keys = new ApiKeys(service.db);
  const root = new RootAuthentication(config.rootCredentials);
  const sessions = new BrowserSessions(service.db);
  const account = new RootAccount(
    service.db,
    config.rootCredentials?.email ?? "root@localhost",
    config.timezone,
  );
  const keyManagement = new KeyManagementSessions(service.db);
  const oauth = config.publicBaseUrl
    ? new OAuthStore(service.db, config.publicBaseUrl + "/mcp")
    : undefined;
  app.onError((error, c) => {
    const failure =
      error instanceof HTTPException && error.status === 408
        ? new DomainError("TIMEOUT", deadlineMessage)
        : publicError(error);
    if (failure.code === "RATE_LIMITED") c.header("Retry-After", "60");
    if (
      failure.code === "LIMIT_EXCEEDED" &&
      failure.message === "Request exceeds 1 MiB"
    )
      c.header("Connection", "close");
    return c.json(failure.toJSON(), failure.status);
  });
  app.use("*", secureHeaders());
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const start = Date.now();
    try {
      await next();
    } finally {
      c.header("Cache-Control", "no-store");
      if (c.req.path !== "/healthz")
        log({
          event: "request",
          method: c.req.method,
          status: c.res.status,
          duration_ms: Date.now() - start,
        });
    }
  });
  app.use(
    "*",
    timeout(25_000, new HTTPException(408, { message: deadlineMessage })),
  );
  app.use("*", async (c, next) => {
    const path = c.req.path;
    const protocolOrigin = c.req.header("origin");
    if (
      protocolOrigin &&
      config.allowedOrigins.includes(protocolOrigin) &&
      (path === "/mcp" ||
        path === "/oauth/token" ||
        path === "/oauth/register" ||
        path.startsWith("/.well-known/oauth-"))
    ) {
      c.header("Access-Control-Allow-Origin", protocolOrigin);
      c.header(
        "Access-Control-Expose-Headers",
        "WWW-Authenticate, MCP-Protocol-Version",
      );
      c.header("Vary", "Origin");
    }
    const remote = c.env?.incoming?.socket.remoteAddress ?? "local-test";
    let address = remote;
    if (config.trustedProxyIps.includes(remote)) {
      const forwarded = c.req.header("x-forwarded-for");
      if (
        forwarded &&
        !forwarded.includes(",") &&
        /^[a-fA-F0-9.:]+$/.test(forwarded)
      )
        address = forwarded;
    }
    const now = Date.now();
    for (const [key, value] of limits)
      if (value.reset <= now) limits.delete(key);
    if (limits.size > 10_000)
      throw new DomainError("RATE_LIMITED", "Request capacity exceeded");
    const bucket = limits.get(address) ?? { count: 0, reset: now + 60_000 };
    bucket.count++;
    limits.set(address, bucket);
    if (bucket.count > config.rateLimit) {
      c.header("Retry-After", "60");
      throw new DomainError("RATE_LIMITED", "Request rate exceeded");
    }
    if (path === "/oauth/register" && c.req.method === "POST") {
      for (const [key, value] of registrationLimits)
        if (value.reset <= now) registrationLimits.delete(key);
      if (registrationLimits.size >= 10_000 && !registrationLimits.has(address))
        throw new DomainError(
          "RATE_LIMITED",
          "Client registration capacity exceeded",
        );
      const registration = registrationLimits.get(address) ?? {
        count: 0,
        reset: now + 60_000,
      };
      registration.count++;
      registrationLimits.set(address, registration);
      if (registration.count > 10)
        throw new DomainError(
          "RATE_LIMITED",
          "Client registration rate exceeded",
        );
    }
    if (
      c.req.method === "POST" &&
      (path === "/auth/api-keys" ||
        path === "/auth/session" ||
        path === "/auth/key-management/session" ||
        path === "/oauth/approve")
    )
      root.limit(address);
    if (
      path.startsWith("/auth/key-management/") &&
      !(path === "/auth/key-management/session" && c.req.method === "POST") &&
      !(
        path === "/auth/key-management/api-keys" &&
        c.req.method === "GET" &&
        /^Bearer vls_/.test(c.req.header("authorization") ?? "")
      )
    ) {
      const raw = c.env?.incoming?.rawHeaders ?? [];
      const authCount = raw.filter(
        (value, index) =>
          index % 2 === 0 && value.toLowerCase() === "authorization",
      ).length;
      const management = await keyManagement.authenticate(
        c.req.header("authorization"),
      );
      if (authCount > 1 || !management)
        throw new DomainError(
          "UNAUTHORIZED",
          "Supply a valid key management session",
        );
      c.set("keyManagementSession", management);
    }
    const mcpPreflight =
      path === "/mcp" &&
      c.req.method === "OPTIONS" &&
      config.allowedOrigins.includes(c.req.header("origin") ?? "");
    if (
      !mcpPreflight &&
      (path.startsWith("/v1") ||
        path === "/mcp" ||
        (path === "/auth/session" &&
          c.req.method !== "POST" &&
          c.req.method !== "OPTIONS") ||
        path === "/auth/profile" ||
        path === "/auth/preferences" ||
        (path === "/auth/key-management/api-keys" &&
          c.req.method === "GET" &&
          /^Bearer vls_/.test(c.req.header("authorization") ?? "")) ||
        path === "/openapi.json" ||
        path === "/readyz")
    ) {
      const raw = c.env?.incoming?.rawHeaders ?? [];
      const authCount = raw.filter(
        (value, index) =>
          index % 2 === 0 && value.toLowerCase() === "authorization",
      ).length;
      const authorization = c.req.header("authorization");
      const primary = authorized(authorization, config);
      const session =
        !primary && (path.startsWith("/v1/") || path.startsWith("/auth/"))
          ? await sessions.authenticate(authorization)
          : undefined;
      const grant =
        !primary && path === "/mcp"
          ? await oauth?.authenticate(authorization)
          : undefined;
      if (
        authCount > 1 ||
        (!primary &&
          !grant &&
          !session &&
          !(await keys.authorized(authorization)))
      ) {
        if (path === "/mcp" && config.publicBaseUrl)
          c.header(
            "WWW-Authenticate",
            oauthChallenge(
              config.publicBaseUrl,
              authorization ? "invalid_token" : undefined,
            ),
          );
        throw new DomainError("UNAUTHORIZED", "Supply a valid HTTP Bearer key");
      }
      if (grant) c.set("oauthScopes", grant.scopes);
      if (session) c.set("browserSession", session);
      if (
        (path === "/v1/api-keys" || path.startsWith("/v1/api-keys/")) &&
        !primary
      )
        throw new DomainError(
          "FORBIDDEN",
          "API key management requires the environment AUTH_KEY",
        );
    }
    if (path !== "/healthz") {
      const host = c.req.header("host") ?? new URL(c.req.url).host;
      if (!config.allowedHosts.includes(host))
        throw new DomainError("FORBIDDEN", "Host is not permitted");
      const origin = c.req.header("origin");
      if (origin) {
        let source: URL;
        try {
          source = new URL(origin);
        } catch {
          throw new DomainError("FORBIDDEN", "Origin is not permitted");
        }
        const sameOrigin =
          source.origin === origin &&
          source.host === new URL(`${source.protocol}//${host}`).host &&
          (source.protocol === "https:" ||
            (source.protocol === "http:" &&
              ["localhost", "127.0.0.1", "[::1]"].includes(source.hostname)));
        const uiRequest =
          [
            "/auth/api-keys",
            "/auth/session",
            "/auth/profile",
            "/auth/preferences",
            "/oauth/request",
            "/oauth/approve",
          ].includes(path) || path.startsWith("/auth/key-management/");
        const permitted =
          uiRequest && config.uiBaseUrl
            ? origin === config.uiBaseUrl
            : path === "/oauth/token" || path === "/oauth/register"
              ? sameOrigin || config.allowedOrigins.includes(origin)
              : path === "/api-keys" ||
                  path.startsWith("/oauth/") ||
                  path === "/auth/api-keys" ||
                  path === "/auth/session"
                ? sameOrigin
                : config.allowedOrigins.includes(origin);
        if (!permitted)
          throw new DomainError("FORBIDDEN", "Origin is not permitted");
      }
    }
    await next();
  });
  app.use("*", async (c, next) => {
    const method = c.req.path === "/oauth/request" ? "GET" : "POST";
    const browserAuth = [
      "/auth/api-keys",
      "/oauth/request",
      "/oauth/approve",
    ].includes(c.req.path);
    const origin = c.req.header("origin");
    if (browserAuth && config.uiBaseUrl && origin === config.uiBaseUrl) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin");
      if (c.req.path.startsWith("/oauth/"))
        c.header("Access-Control-Allow-Credentials", "true");
      if (c.req.method === "OPTIONS") {
        const requested = (c.req.header("access-control-request-headers") ?? "")
          .split(",")
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean);
        if (
          c.req.header("access-control-request-method") !== method ||
          requested.some((value) => value !== "content-type") ||
          [...new URL(c.req.url).searchParams].length
        )
          throw new DomainError("FORBIDDEN", "Preflight is not permitted");
        c.header("Access-Control-Allow-Methods", method);
        c.header("Access-Control-Allow-Headers", "Content-Type");
        return c.body(null, 204);
      }
    }
    await next();
  });
  app.use("*", async (c, next) => {
    const path = c.req.path;
    const protocol =
      path === "/mcp" ||
      path === "/oauth/token" ||
      path === "/oauth/register" ||
      path.startsWith("/.well-known/oauth-");
    const origin = c.req.header("origin");
    if (protocol && origin && config.allowedOrigins.includes(origin)) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin");
      c.header(
        "Access-Control-Expose-Headers",
        "WWW-Authenticate, MCP-Protocol-Version",
      );
      if (c.req.method === "OPTIONS") {
        const methods =
          path === "/mcp"
            ? ["GET", "POST", "DELETE"]
            : path.startsWith("/.well-known/")
              ? ["GET"]
              : ["POST"];
        const headers = (c.req.header("access-control-request-headers") ?? "")
          .split(",")
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean);
        if (
          !methods.includes(
            c.req.header("access-control-request-method") ?? "",
          ) ||
          headers.some(
            (value) =>
              ![
                "authorization",
                "content-type",
                "mcp-protocol-version",
                "accept",
                "last-event-id",
              ].includes(value),
          ) ||
          [...new URL(c.req.url).searchParams].length
        )
          throw new DomainError("FORBIDDEN", "Preflight is not permitted");
        c.header("Access-Control-Allow-Methods", methods.join(", "));
        c.header(
          "Access-Control-Allow-Headers",
          "Authorization, Content-Type, MCP-Protocol-Version, Accept, Last-Event-ID",
        );
        return c.body(null, 204);
      }
    }
    await next();
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: MAX_REQUEST_BYTES,
      onError: () => {
        throw new DomainError("LIMIT_EXCEEDED", "Request exceeds 1 MiB");
      },
    }),
  );
  app.use("*", async (c, next) => {
    const guard = config.assertCredentialAbsent;
    const generation =
      [
        "/auth/api-keys",
        "/auth/session",
        "/auth/key-management/session",
      ].includes(c.req.path) && c.req.method === "POST";
    const tokenExchange =
      !!oauth && c.req.path === "/oauth/token" && c.req.method === "POST";
    const rootSignIn =
      generation ||
      (!!oauth && c.req.path === "/oauth/approve" && c.req.method === "POST");
    const authRequest = generation || c.req.path.startsWith("/oauth/");
    guard(c.req.url);
    const url = new URL(c.req.url);
    guard(url.pathname);
    try {
      guard(decodeURIComponent(url.pathname));
    } catch (error) {
      if (error instanceof DomainError) throw error;
    }
    for (const [key, value] of url.searchParams) {
      guard(key);
      guard(value);
    }
    for (const [key, value] of c.req.raw.headers) {
      guard(key);
      if (key.toLowerCase() !== "authorization") guard(value);
    }
    await inspectBody(
      c.req.raw,
      rootSignIn
        ? config.assertAuthKeyAbsent
        : tokenExchange
          ? config.assertPrimaryCredentialsAbsent
          : guard,
      authRequest ? 4096 : MAX_REQUEST_BYTES,
      authRequest ? "Authentication requests must not exceed 4 KiB" : undefined,
    );
    await next();
    try {
      await inspectBody(
        c.res,
        generation ||
          (c.req.path === "/auth/key-management/api-keys" &&
            c.req.method === "POST") ||
          tokenExchange ||
          (c.req.path === "/oauth/register" && c.req.method === "POST")
          ? config.assertEnvironmentCredentialsAbsent
          : guard,
        MAX_RESPONSE_BYTES,
        "Response exceeds the byte limit; narrow the query",
      );
    } catch (error) {
      if (error instanceof DomainError && error.code === "VALIDATION_ERROR")
        throw new DomainError(
          "INTERNAL_ERROR",
          "The response cannot be returned safely",
        );
      throw error;
    }
  });
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/api-keys", (c) =>
    config.uiBaseUrl
      ? c.redirect(config.uiBaseUrl + "/api-keys", 302)
      : c.notFound(),
  );
  if (oauth)
    app.route(
      "/",
      oauthRoutes(
        root,
        oauth,
        config,
        new OAuthClients(
          service.db,
          config.oauthClients,
          config.assertCredentialAbsent,
          dependencies.clientMetadataFetcher,
        ),
      ),
    );
  app.post("/auth/api-keys", async (c) => {
    if ([...new URL(c.req.url).searchParams].length)
      throw new DomainError(
        "VALIDATION_ERROR",
        "Key generation does not accept query parameters",
      );
    if (
      !/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? "")
    )
      throw new DomainError("VALIDATION_ERROR", "Use application/json");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new DomainError("VALIDATION_ERROR", "Malformed JSON request");
    }
    const parsed = keyCreation.safeParse(body);
    if (!parsed.success)
      throw new DomainError(
        "VALIDATION_ERROR",
        "Supply a valid email and password",
      );
    config.assertCredentialAbsent(parsed.data.email);
    await root.verify(parsed.data.email, parsed.data.password);
    return c.json(await keys.create(), 201);
  });
  app.post("/auth/session", async (c) => {
    if ([...new URL(c.req.url).searchParams].length)
      throw new DomainError(
        "VALIDATION_ERROR",
        "Sign-in does not accept query parameters",
      );
    if (
      !/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? "")
    )
      throw new DomainError("VALIDATION_ERROR", "Use application/json");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new DomainError("VALIDATION_ERROR", "Malformed JSON request");
    }
    const parsed = keyCreation.safeParse(body);
    if (!parsed.success)
      throw new DomainError(
        "VALIDATION_ERROR",
        "Supply a valid email and password",
      );
    config.assertCredentialAbsent(parsed.data.email);
    await root.verify(parsed.data.email, parsed.data.password);
    return c.json(await sessions.create(), 201);
  });
  app.get("/auth/session", async (c) => {
    if ([...new URL(c.req.url).searchParams].length)
      throw new DomainError(
        "VALIDATION_ERROR",
        "Session lookup does not accept query parameters",
      );
    const session = c.get("browserSession");
    if (!session)
      throw new DomainError("UNAUTHORIZED", "Supply a valid browser session");
    return c.json({
      expires_at: session.expiresAt.toISOString(),
      timezone: config.timezone,
      today: localDate(new Date(), config.timezone),
      account: await account.get(),
    });
  });
  for (const [path, method, schema] of [
    ["/auth/profile", "PATCH", profileSchema],
    ["/auth/preferences", "PUT", preferencesSchema],
  ] as const) {
    app.on(method, path, async (c) => {
      if (!c.get("browserSession"))
        throw new DomainError("UNAUTHORIZED", "Supply a valid browser session");
      if (
        new URL(c.req.url).search ||
        !/^application\/json(?:\s*;|$)/i.test(
          c.req.header("content-type") ?? "",
        )
      )
        throw new DomainError(
          "VALIDATION_ERROR",
          "Use application/json without query parameters",
        );
      let input: unknown;
      try {
        input = await c.req.json();
      } catch {
        throw new DomainError("VALIDATION_ERROR", "Malformed JSON request");
      }
      const parsed = schema.safeParse(input);
      if (!parsed.success)
        throw new DomainError(
          "VALIDATION_ERROR",
          "Supply valid account settings",
        );
      return c.json(await account.update(parsed.data));
    });
  }
  app.delete("/auth/session", async (c) => {
    if (
      [...new URL(c.req.url).searchParams].length ||
      (await c.req.text()).length
    )
      throw new DomainError(
        "VALIDATION_ERROR",
        "Sign-out does not accept a body or query parameters",
      );
    const session = c.get("browserSession");
    if (!session)
      throw new DomainError("UNAUTHORIZED", "Supply a valid browser session");
    await sessions.revoke(session.id);
    return c.json({ signed_out: true });
  });
  app.get("/v1/api-keys", async (c) => {
    const query = new URL(c.req.url).searchParams;
    const input: Record<string, number> = {};
    for (const [key, value] of query) {
      if (
        !["limit", "offset"].includes(key) ||
        query.getAll(key).length !== 1 ||
        !/^(0|[1-9]\d*)$/.test(value)
      )
        throw new DomainError(
          "VALIDATION_ERROR",
          "Use one integer limit and offset parameter",
        );
      input[key] = Number(value);
    }
    const parsed = keyListQuery.safeParse(input);
    if (!parsed.success)
      throw new DomainError(
        "VALIDATION_ERROR",
        "Limit must be 1–100 and offset 0–1000000",
      );
    return c.json(await keys.list(parsed.data.limit, parsed.data.offset));
  });
  const noRevocationArguments = async (c: Context<AppEnvironment>) => {
    if (
      [...new URL(c.req.url).searchParams].length ||
      c.req.header("content-type") ||
      (await c.req.text()).length
    )
      throw new DomainError(
        "VALIDATION_ERROR",
        "Revocation does not accept a body or query parameters",
      );
  };
  app.delete("/v1/api-keys/:id", async (c) => {
    await noRevocationArguments(c);
    const id = keyId.safeParse(c.req.param("id"));
    if (!id.success)
      throw new DomainError("VALIDATION_ERROR", "Use an API key UUID");
    return c.json(await keys.revoke(id.data));
  });
  app.delete("/v1/api-keys", async (c) => {
    await noRevocationArguments(c);
    return c.json(await keys.revokeAll());
  });
  app.post("/auth/key-management/session", async (c) => {
    if (
      new URL(c.req.url).search ||
      !/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? "")
    )
      throw new DomainError(
        "VALIDATION_ERROR",
        "Use application/json without query parameters",
      );
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new DomainError("VALIDATION_ERROR", "Malformed JSON request");
    }
    const parsed = keyCreation.safeParse(body);
    if (!parsed.success)
      throw new DomainError(
        "VALIDATION_ERROR",
        "Supply a valid email and password",
      );
    config.assertCredentialAbsent(parsed.data.email);
    await root.verify(parsed.data.email, parsed.data.password);
    return c.json(await keyManagement.create(), 201);
  });
  app.get("/auth/key-management/session", (c) => {
    if (new URL(c.req.url).search)
      throw new DomainError(
        "VALIDATION_ERROR",
        "Session lookup does not accept query parameters",
      );
    return c.json({
      expires_at: c.get("keyManagementSession")!.expiresAt.toISOString(),
    });
  });
  app.delete("/auth/key-management/session", async (c) => {
    await noRevocationArguments(c);
    await keyManagement.revoke(c.get("keyManagementSession")!.id);
    return c.json({ signed_out: true });
  });
  app.get("/auth/key-management/api-keys", async (c) => {
    const query = new URL(c.req.url).searchParams;
    const values: Record<string, number> = {};
    for (const [key, value] of query) {
      if (
        !["limit", "offset"].includes(key) ||
        query.getAll(key).length !== 1 ||
        !/^(0|[1-9]\d*)$/.test(value)
      )
        throw new DomainError(
          "VALIDATION_ERROR",
          "Use one integer limit and offset parameter",
        );
      values[key] = Number(value);
    }
    const parsed = keyListQuery.safeParse(values);
    if (!parsed.success)
      throw new DomainError(
        "VALIDATION_ERROR",
        "Limit must be 1–100 and offset 0–1000000",
      );
    return c.json(await keys.list(parsed.data.limit, parsed.data.offset, true));
  });
  app.post("/auth/key-management/api-keys", async (c) => {
    await noRevocationArguments(c);
    return c.json(await keys.create(), 201);
  });
  app.delete("/auth/key-management/api-keys/:id", async (c) => {
    await noRevocationArguments(c);
    const id = keyId.safeParse(c.req.param("id"));
    if (!id.success)
      throw new DomainError("VALIDATION_ERROR", "Use an API key UUID");
    return c.json(await keys.revoke(id.data, true));
  });
  app.delete("/auth/key-management/api-keys", async (c) => {
    await noRevocationArguments(c);
    return c.json(await keys.revokeAll(true));
  });
  app.get("/readyz", async (c) => {
    const ready = await service.ready();
    return c.json(
      { status: ready ? "ready" : "unavailable" },
      ready ? 200 : 503,
    );
  });
  const document = openapi();
  app.get("/openapi.json", (c) => c.json(document));
  app.all("/mcp", (c) =>
    handleMcp(c.req.raw, service, config, c.get("oauthScopes"), log),
  );
  for (const operation of operations) {
    const path = operation.path.replace(/\{([^}]+)\}/g, ":$1");
    const handler = async (c: Context<AppEnvironment>) => {
      if (c.get("browserSession") && operation.mutation)
        throw new DomainError(
          "FORBIDDEN",
          "Browser sessions can only read health data",
        );
      const input: Data = Object.create(null);
      const query = new URL(c.req.url).searchParams;
      if (operation.method === "GET") {
        for (const [key, value] of query) {
          if (query.getAll(key).length !== 1 || !value)
            throw new DomainError(
              "VALIDATION_ERROR",
              "Query values must be nonempty and supplied exactly once",
              [{ path: `/${key}`, reason: "invalid_query" }],
            );
          if (
            [
              "include_history",
              "include_labs",
              "include_schema",
              "include_preliminary",
              "include_undated",
            ].includes(key)
          ) {
            if (!["true", "false"].includes(value))
              throw new DomainError(
                "VALIDATION_ERROR",
                "Booleans must be true or false",
                [{ path: `/${key}`, reason: "invalid_boolean" }],
              );
            input[key] = value === "true";
          } else if (
            [
              "limit",
              "lookback_days",
              "history_limit",
              "history_before_version",
              "record_version",
            ].includes(key)
          ) {
            if (!/^(0|[1-9]\d*)$/.test(value))
              throw new DomainError(
                "VALIDATION_ERROR",
                "Use a nonnegative integer",
                [{ path: `/${key}`, reason: "invalid_integer" }],
              );
            input[key] = Number(value);
          } else if (["metrics", "record_types", "sections"].includes(key))
            input[key] = value.split(",");
          else input[key] = value;
        }
      } else {
        if ([...query].length)
          throw new DomainError(
            "VALIDATION_ERROR",
            "Mutations do not accept query parameters",
          );
        if (
          !(c.req.header("content-type") ?? "").match(
            /^application\/json(?:\s*;|$)/i,
          )
        )
          throw new DomainError("VALIDATION_ERROR", "Use application/json");
        let body: unknown;
        try {
          body = await c.req.json();
        } catch {
          throw new DomainError("VALIDATION_ERROR", "Malformed JSON request");
        }
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new DomainError(
            "VALIDATION_ERROR",
            "Request body must be an object",
          );
        if ("idempotency_key" in body || "id" in body)
          throw new DomainError(
            "VALIDATION_ERROR",
            "Use the path ID and Idempotency-Key header",
          );
        Object.assign(input, body);
        input.idempotency_key = c.req.header("idempotency-key");
        const raw = c.env?.incoming?.rawHeaders ?? [];
        if (
          raw.filter(
            (value, index) =>
              index % 2 === 0 && value.toLowerCase() === "idempotency-key",
          ).length > 1
        )
          throw new DomainError(
            "VALIDATION_ERROR",
            "Idempotency-Key must occur exactly once",
          );
      }
      for (const [key, value] of Object.entries(c.req.param())) {
        if (key in input)
          throw new DomainError(
            "VALIDATION_ERROR",
            "Path arguments cannot be repeated in the query",
          );
        input[key] = value;
      }
      return c.json(await service.execute(operation.name, input));
    };
    if (operation.method === "GET") app.get(path, handler);
    else app.post(path, handler);
  }
  app.notFound((c) =>
    c.json(new DomainError("NOT_FOUND", "Route does not exist").toJSON(), 404),
  );
  return app;
}
