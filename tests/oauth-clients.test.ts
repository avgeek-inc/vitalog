import { EventEmitter } from "node:events";
import { IncomingMessage, type ClientRequest } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { lookup } from "node:dns/promises";
import { Socket } from "node:net";
import { describe, expect, test, vi } from "vitest";
import {
  configuredOAuthClients,
  fetchClientMetadata,
  metadataUrl,
  publicAddress,
  redirectMatches,
  registrationSchema,
  type MetadataNetwork,
} from "../src/auth/oauth-clients.js";
import { authorizationCallback } from "../apps/web/src/lib/oauth.js";

const identifier = "https://client.example.com/oauth/client.json";
const callback = "https://client.example.com/callback?tenant=one";
const issuer = "https://vitalog-api.praveent.com";
function network(
  addresses = [{ address: "93.184.216.34", family: 4 }],
  status = 200,
  content = '{"client_id":"example"}',
  contentType = "application/json",
) {
  const resolver = vi.fn(async () => addresses);
  const outgoing = vi.fn(
    (
      url: URL,
      options: RequestOptions,
      receive: (response: IncomingMessage) => void,
    ) => {
      expect(url.hostname).toBe("client.example.com");
      expect(options.agent).toBe(false);
      expect(options.rejectUnauthorized).not.toBe(false);
      const response = new IncomingMessage(new Socket());
      response.statusCode = status;
      response.headers = {
        "content-type": contentType,
        "cache-control": "max-age=90",
      };
      return Object.assign(new EventEmitter(), {
        end: () => {
          receive(response);
          queueMicrotask(() => {
            response.push(content);
            response.push(null);
          });
        },
      }) as ClientRequest;
    },
  );
  return {
    resolver,
    outgoing,
    transport: {
      lookup: resolver as unknown as typeof lookup,
      request: outgoing as unknown as typeof httpsRequest,
    } satisfies MetadataNetwork,
  };
}
describe("MCP OAuth client trust boundaries", () => {
  test.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.100.100.200",
    "127.0.0.1",
    "169.254.169.254",
    "172.20.1.1",
    "192.168.2.1",
    "192.0.2.1",
    "198.18.0.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:93.184.216.34",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "2002:a00:1::1",
    "3fff::1",
  ])(
    "Metadata cannot fetch private, special-use or mapped address %s",
    (address) => expect(publicAddress(address)).toBe(false),
  );
  test.each(["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"])(
    "Public address %s can host metadata",
    (address) => expect(publicAddress(address)).toBe(true),
  );
  test.each([
    "http://client.example.com/client.json",
    "https://localhost/client.json",
    "https://127.0.0.1/client.json",
    "https://2130706433/client.json",
    "https://0x7f000001/client.json",
    "https://[::1]/client.json",
    "https://169.254.169.254/latest/meta-data/",
    "https://10.1.2.3/client.json",
    "https://client.example.com",
    "https://client.example.com/client.json#fragment",
    "https://client.example.com/client.json#",
    "https://owner:password@client.example.com/client.json",
    "https://client.example.com/path/../client.json",
    "https://client.example.com/path/%2e%2E/client.json",
    "file:///etc/passwd",
    "unregistered-client",
  ])("Rejects unsafe metadata URL %s before fetching", (value) =>
    expect(() => metadataUrl(value)).toThrow(),
  );
  test("Pins the connection to validated DNS results and preserves TLS validation and cache headers", async () => {
    const fixture = network();
    const document = await fetchClientMetadata(identifier, fixture.transport);
    expect(document.cacheControl).toBe("max-age=90");
    expect(fixture.resolver).toHaveBeenCalledTimes(1);
    const options = fixture.outgoing.mock.calls[0]![1];
    expect(options.family).toBe(4);
    const pinned = vi.fn();
    options.lookup!("client.example.com", { family: 4 }, pinned);
    options.lookup!("client.example.com", { family: 4 }, pinned);
    expect(pinned.mock.calls).toEqual([
      [null, "93.184.216.34", 4],
      [null, "93.184.216.34", 4],
    ]);
    expect(fixture.resolver).toHaveBeenCalledTimes(1);
  });
  test("Rejects DNS rebinding targets and mixed public/private resolution before connecting", async () => {
    for (const addresses of [
      [{ address: "169.254.169.254", family: 4 }],
      [
        { address: "93.184.216.34", family: 4 },
        { address: "10.1.2.3", family: 4 },
      ],
    ]) {
      const fixture = network(addresses);
      await expect(
        fetchClientMetadata(identifier, fixture.transport),
      ).rejects.toThrow("public addresses");
      expect(fixture.outgoing).not.toHaveBeenCalled();
    }
  });
  test("Does not follow HTTP redirects, accept non-JSON bodies or buffer oversized documents", async () => {
    for (const fixture of [
      network(undefined, 302),
      network(undefined, 200, "<html>", "text/html"),
      network(undefined, 200, "x".repeat(5121)),
    ]) {
      await expect(
        fetchClientMetadata(identifier, fixture.transport),
      ).rejects.toThrow();
      expect(fixture.outgoing).toHaveBeenCalledTimes(1);
    }
  });
  test("Registration supports public and confidential clients and rejects unsafe callbacks", () => {
    expect(
      registrationSchema.parse({ redirect_uris: [callback] })
        .token_endpoint_auth_method,
    ).toBe("client_secret_basic");
    for (const uri of [
      callback,
      "http://127.0.0.1:49152/callback",
      "http://[::1]:49152/callback",
      "com.example.client:/callback",
    ])
      expect(
        registrationSchema.safeParse({
          client_name: "Example",
          redirect_uris: [uri],
          token_endpoint_auth_method: "none",
        }).success,
      ).toBe(true);
    for (const uri of [
      "http://remote.example.com/callback",
      "javascript:alert(1)",
      "data:text/html,hello",
      "file:///tmp/callback",
      "myapp:/callback",
      "https://app.example.com/callback#fragment",
      "https://user:password@app.example.com/callback",
      callback + "&code=injected",
    ])
      expect(
        registrationSchema.safeParse({ redirect_uris: [uri] }).success,
      ).toBe(false);
  });
  test("Only literal loopback callbacks allow a changing port; every other URI component remains bound", () => {
    expect(
      redirectMatches(
        "http://127.0.0.1/callback",
        "http://127.0.0.1:49152/callback",
      ),
    ).toBe(true);
    expect(
      redirectMatches(
        "http://[::1]:8000/callback",
        "http://[::1]:49152/callback",
      ),
    ).toBe(true);
    for (const supplied of [
      "http://127.0.0.1:49152/different",
      "http://localhost:49152/callback",
      "http://127.0.0.1:49152/callback?other=1",
    ])
      expect(redirectMatches("http://127.0.0.1/callback", supplied)).toBe(
        false,
      );
    expect(
      redirectMatches(
        "http://localhost:8000/callback",
        "http://localhost:49152/callback",
      ),
    ).toBe(false);
    expect(redirectMatches(callback, callback + "&extra=one")).toBe(false);
  });
  test("Configured client secrets are hashed and invalid configurations fail without revealing input", () => {
    const secret = "vcs_" + "x".repeat(43);
    const parsed = configuredOAuthClients(
      JSON.stringify([
        {
          client_id: "configured-cli",
          client_name: "Configured CLI",
          redirect_uris: [callback],
          token_endpoint_auth_method: "client_secret_post",
          client_secret: secret,
        },
      ]),
    );
    expect(parsed.secrets).toEqual([secret]);
    expect(JSON.stringify(parsed.clients)).not.toContain(secret);
    expect(parsed.clients[0]!.clientSecretDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(() =>
      configuredOAuthClients(
        JSON.stringify([
          {
            client_id: "configured-cli",
            redirect_uris: [callback],
            client_secret: secret,
          },
        ]),
      ),
    ).toThrow("OAUTH_CLIENTS");
    const entry = { client_id: "configured-cli", redirect_uris: [callback] };
    expect(() =>
      configuredOAuthClients(JSON.stringify([entry, entry])),
    ).toThrow();
  });
});
describe("Consent callback validation", () => {
  const code = "voc_" + "x".repeat(43);
  const response = (target = callback) => {
    const uri = new URL(target);
    uri.searchParams.set("code", code);
    uri.searchParams.set("state", "example-state");
    uri.searchParams.set("iss", issuer);
    return uri.href;
  };
  test.each([
    callback,
    "https://client.example.com/callback?tenant=hello%20world&suffix=~",
    "http://127.0.0.1:49152/callback",
    "com.example.client:/callback",
  ])("Allows only the consented callback %s", (uri) =>
    expect(authorizationCallback(issuer, uri, response(uri), "allow")).toBe(
      response(uri),
    ),
  );
  test("Rejects a changed issuer, callback, fragment, duplicate code or direct access token", () => {
    const valid = new URL(response());
    for (const mutate of [
      (uri: URL) => uri.searchParams.set("iss", "https://attacker.example.com"),
      (uri: URL) => {
        uri.hostname = "attacker.example.com";
      },
      (uri: URL) => {
        uri.hash = "fragment";
      },
      (uri: URL) => uri.searchParams.append("code", code),
      (uri: URL) =>
        uri.searchParams.set("access_token", "vlo_" + "y".repeat(43)),
    ]) {
      const uri = new URL(valid);
      mutate(uri);
      expect(() =>
        authorizationCallback(issuer, callback, uri.href, "allow"),
      ).toThrow();
    }
  });
  test("Cancellation validates the same callback and carries no authorization code", () => {
    const denied = new URL(callback);
    denied.searchParams.set("error", "access_denied");
    denied.searchParams.set("iss", issuer);
    expect(authorizationCallback(issuer, callback, denied.href, "deny")).toBe(
      denied.href,
    );
    denied.searchParams.set("code", code);
    expect(() =>
      authorizationCallback(issuer, callback, denied.href, "deny"),
    ).toThrow();
  });
});
