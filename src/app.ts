import type { HttpBindings } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { timeout } from "hono/timeout";
import { authorized, type Config } from "./config.js";
import { DomainError, publicError } from "./errors.js";
import { handleMcp } from "./mcp.js";
import { openapi } from "./openapi.js";
import { operations } from "./registry/operations.js";
import type { Service } from "./service.js";
import type { Data } from "./domain/types.js";
import { inspectBody, MAX_REQUEST_BYTES } from "./security.js";
import { MAX_RESPONSE_BYTES } from "./domain/catalog.js";

export function application(
  service: Service,
  config: Config,
  log = (entry: Data) => {
    process.stdout.write(JSON.stringify(entry) + "\n");
  },
) {
  const app = new Hono<{ Bindings: HttpBindings }>();
  const limits = new Map<string, { count: number; reset: number }>();
  app.onError((error, c) => {
    const failure = publicError(error);
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
  app.use("*", async (c, next) => {
    const path = c.req.path;
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
      if (authCount > 1 || !authorized(c.req.header("authorization"), config))
        throw new DomainError(
          "UNAUTHORIZED",
          "Supply the configured HTTP Bearer key",
        );
    }
    if (path !== "/healthz") {
      const host = c.req.header("host") ?? new URL(c.req.url).host;
      if (!config.allowedHosts.includes(host))
        throw new DomainError("FORBIDDEN", "Host is not permitted");
      const origin = c.req.header("origin");
      if (origin && !config.allowedOrigins.includes(origin))
        throw new DomainError("FORBIDDEN", "Origin is not permitted");
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
    await next();
  });
  app.use(
    "*",
    timeout(25_000, () => {
      throw new DomainError(
        "TIMEOUT",
        "Request exceeded its deadline; mutations may be retried with the same idempotency key",
      );
    }),
  );
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
    await inspectBody(c.req.raw, guard);
    await next();
    try {
      await inspectBody(
        c.res,
        guard,
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
