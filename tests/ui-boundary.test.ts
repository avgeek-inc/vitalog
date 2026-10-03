import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, test } from "vitest";
import { application } from "../src/app.js";
import { configuration } from "../src/config.js";
import { database } from "../src/db/client.js";
import { Service } from "../src/service.js";
import { webConfiguration } from "../apps/web/src/lib/config.js";

const issuer = "https://vitalog-api.praveent.com";
const ui = "https://vitalog.praveent.com";
const connection = database("postgresql://unused.invalid/ui-boundary-test");
const config = configuration({
  AUTH_KEY: randomBytes(32).toString("base64url"),
  DATABASE_URL: connection.pool.options.connectionString,
  ALLOWED_HOSTS: new URL(issuer).host,
  PUBLIC_BASE_URL: issuer,
  UI_BASE_URL: ui,
});
const app = application(
  new Service(connection.db, config.timezone, "fixture"),
  config,
  () => {},
);
afterAll(() => connection.pool.end());

describe("Separate UI and API origins", () => {
  test("An unconfigured consent UI fails closed instead of redirecting to itself", async () => {
    const withoutUi = { ...config, uiBaseUrl: undefined };
    const server = application(
      new Service(connection.db, config.timezone, "fixture"),
      withoutUi,
      () => {},
    );
    const result = await server.request(issuer + "/oauth/authorize");
    expect(result.status).toBe(503);
    expect(result.headers.get("location")).toBeNull();
    const approval = await server.request(issuer + "/oauth/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(approval.status).toBe(400);
  });
  test("The API redirects legacy UI entry points to a configured origin without forwarding parameters", async () => {
    const result = await app.request(issuer + "/api-keys?ignored=value");
    expect(result.status).toBe(302);
    expect(result.headers.get("location")).toBe(ui + "/api-keys");
    expect(result.headers.get("cache-control")).toBe("no-store");
  });
  test.each(["/auth/api-keys", "/oauth/approve"])(
    "Preflight admits only the configured UI and JSON POST for %s",
    async (path) => {
      const headers = {
        Origin: ui,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      };
      const accepted = await app.request(issuer + path, {
        method: "OPTIONS",
        headers,
      });
      expect(accepted.status).toBe(204);
      expect(accepted.headers.get("access-control-allow-origin")).toBe(ui);
      expect(accepted.headers.get("vary")).toBe("Origin");
      expect(accepted.headers.get("access-control-allow-credentials")).toBe(
        path === "/oauth/approve" ? "true" : null,
      );
      for (const override of [
        { Origin: "https://attacker.praveent.com" },
        { Origin: "null" },
        { "Access-Control-Request-Method": "DELETE" },
        { "Access-Control-Request-Headers": "authorization" },
        { Host: "attacker.example" },
      ] as Record<string, string>[])
        expect(
          (
            await app.request(issuer + path, {
              method: "OPTIONS",
              headers: { ...headers, ...override },
            })
          ).status,
        ).toBe(403);
    },
  );
  test("Cookie-backed consent reads expose errors to the UI without widening ledger or token CORS", async () => {
    const result = await app.request(issuer + "/oauth/request", {
      headers: { Origin: ui },
    });
    expect(result.status).toBe(400);
    expect(result.headers.get("access-control-allow-origin")).toBe(ui);
    expect(result.headers.get("access-control-allow-credentials")).toBe("true");
    for (const path of [
      "/v1/catalog",
      "/oauth/token",
      "/.well-known/oauth-authorization-server",
    ]) {
      const blocked = await app.request(issuer + path, {
        method: "OPTIONS",
        headers: { Origin: ui, "Access-Control-Request-Method": "POST" },
      });
      expect(blocked.headers.get("access-control-allow-origin")).toBeNull();
      expect(blocked.status).not.toBe(204);
    }
  });
  test("Untrusted browser origins are rejected before credential verification", async () => {
    for (const path of ["/auth/api-keys", "/oauth/approve", "/oauth/request"]) {
      const result = await app.request(issuer + path, {
        method: path.endsWith("request") ? "GET" : "POST",
        headers: {
          Origin: "https://attacker.praveent.com",
          "Content-Type": "application/json",
        },
        body: path.endsWith("request") ? undefined : "{}",
      });
      expect(result.status).toBe(403);
      expect(result.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
  test("Runtime UI configuration accepts only canonical HTTPS origins or loopback development", () => {
    expect(webConfiguration({ API_BASE_URL: issuer, UI_BASE_URL: ui })).toEqual(
      { apiBaseUrl: issuer, uiBaseUrl: ui },
    );
    expect(
      webConfiguration({
        API_BASE_URL: "http://127.0.0.1:3000",
        UI_BASE_URL: "http://127.0.0.1:3001",
      }).apiBaseUrl,
    ).toBe("http://127.0.0.1:3000");
    for (const invalid of [
      undefined,
      "http://api.example",
      issuer + "/",
      issuer + "/path",
      issuer + "?query=value",
      "https://user:password@api.example",
    ]) {
      expect(() =>
        webConfiguration({ API_BASE_URL: invalid, UI_BASE_URL: ui }),
      ).toThrow();
      expect(() =>
        configuration({
          ...process.env,
          AUTH_KEY: randomBytes(32).toString("base64url"),
          DATABASE_URL: "postgresql://unused.invalid/test",
          UI_BASE_URL: invalid || "http://ui.example",
        }),
      ).toThrow();
    }
  });
});
