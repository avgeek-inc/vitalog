import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import { configuration } from "../src/config.js";
import { application } from "../src/app.js";
import { database } from "../src/db/client.js";
import { Service } from "../src/service.js";
import { pkceChallenge } from "../src/auth/oauth-store.js";

const env = {
  AUTH_KEY: randomBytes(32).toString("base64url"),
  DATABASE_URL: "postgresql://unused.invalid/oauth-test",
};

describe("OAuth configuration and discovery", () => {
  test("Infers the issuer from one public host and allows an explicit loopback development issuer", () => {
    expect(
      configuration({
        ...env,
        ALLOWED_HOSTS: "vitalog.praveent.com,localhost:3000",
      }).publicBaseUrl,
    ).toBe("https://vitalog.praveent.com");
    expect(configuration(env).publicBaseUrl).toBeUndefined();
    expect(
      configuration({
        ...env,
        ALLOWED_HOSTS: "one.example.test,two.example.test",
      }).publicBaseUrl,
    ).toBeUndefined();
    expect(
      configuration({ ...env, PUBLIC_BASE_URL: "http://127.0.0.1:3000" })
        .publicBaseUrl,
    ).toBe("http://127.0.0.1:3000");
  });
  test.each([
    "http://vitalog.praveent.com",
    "https://untrusted.example",
    "https://vitalog.praveent.com/path",
    "https://vitalog.praveent.com/",
    "https://user:password@vitalog.praveent.com",
    "https://vitalog.praveent.com?token=unused",
  ])("Rejects an insecure or noncanonical issuer: %s", (PUBLIC_BASE_URL) => {
    expect(() =>
      configuration({
        ...env,
        ALLOWED_HOSTS: "vitalog.praveent.com",
        PUBLIC_BASE_URL,
      }),
    ).toThrow();
  });
  test("Discovery and the MCP challenge agree on the issuer, audience, scopes and PKCE", async () => {
    const connection = database(env.DATABASE_URL);
    try {
      const config = configuration({
        ...env,
        ALLOWED_HOSTS: "vitalog.praveent.com",
      });
      const app = application(
        new Service(connection.db, config.timezone, "synthetic-cursor"),
        config,
        () => {},
      );
      const request = (path: string) =>
        app.request("https://vitalog.praveent.com" + path);
      const metadata = await (
        await request("/.well-known/oauth-protected-resource/mcp")
      ).json();
      const issuer = await (
        await request("/.well-known/oauth-authorization-server")
      ).json();
      expect(metadata.resource).toBe("https://vitalog.praveent.com/mcp");
      expect(metadata.authorization_servers).toEqual([issuer.issuer]);
      expect(issuer.code_challenge_methods_supported).toEqual(["S256"]);
      expect(issuer.token_endpoint_auth_methods_supported).toEqual(["none"]);
      expect(issuer.client_id_metadata_document_supported).toBe(true);
      expect(issuer.authorization_response_iss_parameter_supported).toBe(true);
      expect(issuer.grant_types_supported).toEqual(["authorization_code"]);
      const denied = await request("/mcp");
      expect(denied.status).toBe(401);
      expect(denied.headers.get("www-authenticate")).toContain(
        'resource_metadata="https://vitalog.praveent.com/.well-known/oauth-protected-resource/mcp"',
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
