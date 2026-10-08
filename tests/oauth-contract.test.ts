import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import { configuration } from "../src/config.js";
import { application } from "../src/app.js";
import { database } from "../src/db/client.js";
import { Service } from "../src/service.js";
import { pkceChallenge } from "../src/auth/oauth-store.js";
import { operations } from "../src/registry/operations.js";

const env = {
  AUTH_KEY: randomBytes(32).toString("base64url"),
  DATABASE_URL: "postgresql://unused.invalid/oauth-test",
};

describe("OAuth configuration and discovery", () => {
  test("Derives allowed hosts from the public API origin and retains local readiness hosts", () => {
    const config = configuration({
      ...env,
      PUBLIC_BASE_URL: "https://vitalog-api.praveent.com",
    });
    expect(config.publicBaseUrl).toBe("https://vitalog-api.praveent.com");
    expect(config.allowedHosts).toEqual(
      expect.arrayContaining([
        "vitalog-api.praveent.com",
        "vitalog-api.praveent.com:443",
        "localhost:3000",
        "127.0.0.1:3000",
      ]),
    );
    expect(config.allowedHosts).not.toContain("untrusted.example");
    expect(configuration(env).publicBaseUrl).toBeUndefined();
    expect(
      configuration({ ...env, PUBLIC_BASE_URL: "http://127.0.0.1:3000" })
        .publicBaseUrl,
    ).toBe("http://127.0.0.1:3000");
    expect(
      configuration({
        ...env,
        PUBLIC_BASE_URL: "https://api.example.test:8443",
      }).allowedHosts,
    ).toContain("api.example.test:8443");
  });
  test("Default ports produce a canonical issuer while preserving exact ingress Host values", async () => {
    const connection = database(env.DATABASE_URL);
    try {
      for (const host of [
        "vitalog-api.praveent.com",
        "vitalog-api.praveent.com:443",
      ]) {
        const config = configuration({
          ...env,

          UI_BASE_URL: "https://vitalog.praveent.com",
          PUBLIC_BASE_URL: "https://vitalog-api.praveent.com",
        });
        expect(config.publicBaseUrl).toBe("https://vitalog-api.praveent.com");
        expect(config.allowedHosts).toContain("vitalog-api.praveent.com:443");
        expect(config.allowedHosts).toContain("vitalog-api.praveent.com");
        const app = application(
          new Service(connection.db, "synthetic-cursor"),
          config,
          () => {},
        );
        const page = await app.request(
          "https://vitalog-api.praveent.com/api-keys",
          {
            headers: {
              Host: host,
              Origin: "https://vitalog-api.praveent.com",
            },
          },
        );
        expect(page.status).toBe(302);
        expect(page.headers.get("location")).toBe(
          "https://vitalog.praveent.com/api-keys",
        );
        const discovery = await app.request(
          "https://vitalog-api.praveent.com/mcp",
          {
            method: "POST",
            headers: {
              Host: host,
              Authorization: "Bearer " + env.AUTH_KEY,
              Accept: "application/json, text/event-stream",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/list",
              params: {},
            }),
          },
        );
        expect(discovery.status).toBe(200);
        expect((await discovery.json()).result.tools).toHaveLength(
          operations.length,
        );
      }
    } finally {
      await connection.pool.end();
    }
  });
  test.each([
    "http://vitalog-api.praveent.com",
    "https://vitalog-api.praveent.com/path",
    "https://vitalog-api.praveent.com/",
    "https://user:password@vitalog-api.praveent.com",
    "https://vitalog-api.praveent.com?token=unused",
  ])("Rejects an insecure or noncanonical issuer: %s", (PUBLIC_BASE_URL) => {
    expect(() =>
      configuration({
        ...env,

        PUBLIC_BASE_URL,
      }),
    ).toThrow();
  });
  test("Discovery and the MCP challenge agree on the issuer, audience, scopes and PKCE", async () => {
    const connection = database(env.DATABASE_URL);
    try {
      const config = configuration({
        ...env,
        PUBLIC_BASE_URL: "https://vitalog-api.praveent.com",
      });
      const app = application(
        new Service(connection.db, "synthetic-cursor"),
        config,
        () => {},
      );
      const request = (path: string) =>
        app.request("https://vitalog-api.praveent.com" + path);
      const metadata = await (
        await request("/.well-known/oauth-protected-resource/mcp")
      ).json();
      const issuer = await (
        await request("/.well-known/oauth-authorization-server")
      ).json();
      expect(metadata.resource).toBe("https://vitalog-api.praveent.com/mcp");
      expect(metadata.authorization_servers).toEqual([issuer.issuer]);
      expect(issuer.code_challenge_methods_supported).toEqual(["S256"]);
      expect(issuer.token_endpoint_auth_methods_supported).toEqual([
        "none",
        "client_secret_basic",
        "client_secret_post",
        "private_key_jwt",
      ]);
      expect(issuer.registration_endpoint).toBe(
        "https://vitalog-api.praveent.com/oauth/register",
      );
      expect(issuer.client_id_metadata_document_supported).toBe(true);
      expect(issuer.authorization_response_iss_parameter_supported).toBe(true);
      expect(issuer.grant_types_supported).toEqual(["authorization_code"]);
      const denied = await request("/mcp");
      expect(denied.status).toBe(401);
      expect(denied.headers.get("www-authenticate")).toContain(
        'resource_metadata="https://vitalog-api.praveent.com/.well-known/oauth-protected-resource/mcp"',
      );
      expect(
        await (await request("/.well-known/oauth-protected-resource")).json(),
      ).toEqual(metadata);
      config.assertCredentialAbsent(JSON.stringify(metadata));
      config.assertCredentialAbsent(JSON.stringify(issuer));
    } finally {
      await connection.pool.end();
    }
  });
  test("S256 follows the RFC 7636 test vector", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
  test("OAuth access tokens are rejected in health content and URLs", () => {
    const config = configuration(env);
    const token = "vlo_" + randomBytes(32).toString("base64url");
    expect(() => config.assertCredentialAbsent(token)).toThrow();
    expect(() =>
      config.assertCredentialAbsent("https://example.test?key=" + token),
    ).toThrow();
    expect(() =>
      config.assertEnvironmentCredentialsAbsent(token),
    ).not.toThrow();
  });
});
