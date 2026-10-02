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
import { keyCreation, keyId, keyListQuery } from "./auth/contracts.js";
import { keyPage, keyPageCsp } from "./auth/page.js";

const deadlineMessage =
  "Request exceeded its deadline; mutations may be retried with the same idempotency key";

export function application(
  service: Service,
  config: Config,
  log = (entry: Data) => {
    process.stdout.write(JSON.stringify(entry) + "\n");
  },
) {
  const app = new Hono<{ Bindings: HttpBindings }>();
  const limits = new Map<string, { count: number; reset: number }>();
  const keys = new ApiKeys(service.db);
  const root = new RootAuthentication(config.rootCredentials);
  app.onError((error, c) => {
    const failure =
      error instanceof HTTPException && error.status === 408
        ? new DomainError("TIMEOUT", deadlineMessage)
        : publicError(error);
    if (failure.code === "RATE_LIMITED") c.header("Retry-After", "60");
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
    if (path === "/auth/api-keys" && c.req.method === "POST")
      root.limit(address);
    if (
      path.startsWith("/v1") ||
      path === "/mcp" ||
      path === "/openapi.json" ||
      path === "/readyz"
    ) {
      const raw = c.env?.incoming?.rawHeaders ?? [];
      const authCount = raw.filter(
        (value, index) =>
          index % 2 === 0 && value.toLowerCase() === "authorization",
      ).length;
      const authorization = c.req.header("authorization");
      const primary = authorized(authorization, config);
      if (
        authCount > 1 ||
        (!primary && !(await keys.authorized(authorization)))
      )
        throw new DomainError("UNAUTHORIZED", "Supply a valid HTTP Bearer key");
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
          source.host === host &&
          (source.protocol === "https:" ||
            (source.protocol === "http:" &&
              ["localhost", "127.0.0.1", "[::1]"].includes(source.hostname)));
        if (
          path === "/auth/api-keys"
            ? !sameOrigin
            : !config.allowedOrigins.includes(origin)
        )
          throw new DomainError("FORBIDDEN", "Origin is not permitted");
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
      c.req.path === "/auth/api-keys" && c.req.method === "POST";
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
      generation ? config.assertAuthKeyAbsent : guard,
      generation ? 4096 : MAX_REQUEST_BYTES,
      generation ? "Key generation requests must not exceed 4 KiB" : undefined,
    );
    await next();
    try {
      await inspectBody(
        c.res,
        generation ? config.assertEnvironmentCredentialsAbsent : guard,
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
  app.get("/api-keys", (c) => {
    c.header("Content-Security-Policy", keyPageCsp);
    c.header("Referrer-Policy", "no-referrer");
    return c.html(keyPage);
  });
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
        "Supply a valid email, password and optional key name",
      );
    config.assertCredentialAbsent(parsed.data.email);
    if (parsed.data.name) config.assertCredentialAbsent(parsed.data.name);
    await root.verify(parsed.data.email, parsed.data.password);
    return c.json(await keys.create(parsed.data.name), 201);
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
  const noRevocationArguments = async (
    c: Context<{ Bindings: HttpBindings }>,
  ) => {
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
  app.get("/readyz", async (c) => {
    const ready = await service.ready();
    return c.json(
      { status: ready ? "ready" : "unavailable" },
      ready ? 200 : 503,
    );
  });
  const document = openapi();
  app.get("/openapi.json", (c) => c.json(document));
  app.all("/mcp", (c) => handleMcp(c.req.raw, service, config));
  for (const operation of operations) {
    const path = operation.path.replace(/\{([^}]+)\}/g, ":$1");
    const handler = async (c: Context<{ Bindings: HttpBindings }>) => {
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
