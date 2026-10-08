import { randomBytes } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { authorized, configuration } from "../src/config.js";
import { RootAuthentication } from "../src/auth/root.js";
import {
  keyCreated,
  manualKeyCreation,
  credentialsSchema,
  keyCreation,
  keyListQuery,
  keyOperations,
} from "../src/auth/contracts.js";
import { openapi } from "../src/openapi.js";
import type { Data } from "../src/domain/types.js";
import { application } from "../src/app.js";
import { ApiKeys } from "../src/auth/keys.js";
import { database } from "../src/db/client.js";
import { Service } from "../src/service.js";

const key = randomBytes(32).toString("base64url");
const password = "Unit-only-root-password-2026!";
const env = {
  AUTH_KEY: key,
  DATABASE_URL: "postgresql://unused.invalid/auth-test",
};

describe("Root credential configuration", () => {
  test("Existing AUTH_KEY installations can start without root credentials", () => {
    const config = configuration(env);
    expect(config.rootCredentials).toBeUndefined();
    expect(authorized(`Bearer ${key}`, config)).toBe(true);
  });
  test.each([
    { ROOT_EMAIL: "owner@example.test" },
    { ROOT_PASSWORD: password },
    { ROOT_EMAIL: "invalid", ROOT_PASSWORD: password },
    { ROOT_EMAIL: "owner@example.t", ROOT_PASSWORD: password },
    { ROOT_EMAIL: "owner@example.test", ROOT_PASSWORD: "too-short" },
    { ROOT_EMAIL: "owner@example.test", ROOT_PASSWORD: " ".repeat(40) },
    { ROOT_EMAIL: "owner@example.test", ROOT_PASSWORD: "🙂".repeat(65) },
    { ROOT_EMAIL: "owner@example.test", ROOT_PASSWORD: key },
  ])(
    "Rejects incomplete or invalid configuration without exposing values",
    (root) => {
      let message = "";
      try {
        configuration({ ...env, ...root });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(password);
      expect(message).not.toContain(key);
    },
  );
  test("Email matching is normalized and both credentials are required", async () => {
    const config = configuration({
      ...env,
      ROOT_EMAIL: " Owner@Example.test ",
      ROOT_PASSWORD: password,
    });
    const root = new RootAuthentication(config.rootCredentials);
    await expect(
      root.verify("OWNER@example.test", password),
    ).resolves.toBeUndefined();
    await expect(
      root.verify("other@example.test", password),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      root.verify("owner@example.test", "incorrect-password"),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(JSON.stringify(config.rootCredentials)).not.toContain(password);
  });
  test("Disabled root authentication fails closed", async () => {
    await expect(
      new RootAuthentication(undefined).verify("owner@example.test", password),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
  test("Root verification is salted independently for each process", () => {
    const first = configuration({
      ...env,
      ROOT_EMAIL: "owner@example.test",
      ROOT_PASSWORD: password,
    });
    const second = configuration({
      ...env,
      ROOT_EMAIL: "owner@example.test",
      ROOT_PASSWORD: password,
    });
    expect(
      first.rootCredentials!.salt.equals(second.rootCredentials!.salt),
    ).toBe(false);
    expect(
      first.rootCredentials!.passwordDigest.equals(
        second.rootCredentials!.passwordDigest,
      ),
    ).toBe(false);
  });
});

describe("Key generation contracts", () => {
  test("The request deadline also bounds a stalled generated-key lookup", async () => {
    vi.useFakeTimers();
    const config = configuration(env);
    const connection = database(config.databaseUrl);
    const service = new Service(connection.db, "deadline-test");
    let finish: (value: undefined) => void;
    const lookup = new Promise<undefined>((resolve) => {
      finish = resolve;
    });
    const authentication = vi
      .spyOn(ApiKeys.prototype, "findActive")
      .mockReturnValue(lookup);
    const execute = vi.spyOn(service, "execute");
    try {
      const request = application(service, config, () => {}).request(
        "http://localhost:3000/v1/catalog",
        {
          headers: {
            Host: "localhost:3000",
            Authorization:
              "Bearer vlk_" + randomBytes(32).toString("base64url"),
          },
        },
      );
      await vi.advanceTimersByTimeAsync(25_001);
      const response = await request;
      expect(response.status).toBe(408);
      expect((await response.json()).code).toBe("TIMEOUT");
      expect(execute).not.toHaveBeenCalled();
    } finally {
      finish!(undefined);
      authentication.mockRestore();
      execute.mockRestore();
      vi.useRealTimers();
      await connection.pool.end();
    }
  });
  test("Manual key creation requires explicit name, permissions and expiry", () => {
    const settings = {
      name: "Personal automation",
      access: "read",
      includeAdmin: false,
      expiresAt: null,
    };
    const input = { email: "owner@example.test", password, ...settings };
    expect(keyCreation.parse(input)).toEqual(input);
    for (const field of Object.keys(settings)) {
      const missing: Record<string, unknown> = { ...input };
      delete missing[field];
      expect(keyCreation.safeParse(missing).success).toBe(false);
    }
    for (const invalid of [
      { name: " " },
      { name: "x".repeat(121) },
      { access: "admin" },
      { includeAdmin: "false" },
      { expiresAt: "2020-01-01T00:00:00Z" },
      { access: "read", includeAdmin: true },
    ])
      expect(
        manualKeyCreation.safeParse({ ...settings, ...invalid }).success,
      ).toBe(false);
    expect(credentialsSchema.parse({ email: input.email, password })).toEqual({
      email: input.email,
      password,
    });
    expect(credentialsSchema.safeParse(input).success).toBe(false);
  });
  test("Pagination is bounded", () => {
    expect(keyListQuery.parse({})).toEqual({ limit: 50, offset: 0 });
    expect(keyListQuery.safeParse({ limit: 101 }).success).toBe(false);
    expect(keyListQuery.safeParse({ offset: -1 }).success).toBe(false);
  });
  test("Only the creation response admits a complete token", () => {
    const token = "vlk_" + randomBytes(32).toString("base64url");
    const config = configuration({
      ...env,
      ROOT_EMAIL: "owner@example.test",
      ROOT_PASSWORD: password,
    });
    expect(() => config.assertCredentialAbsent(token)).toThrow();
    expect(() => config.assertCredentialAbsent(password)).toThrow();
    expect(() =>
      config.assertEnvironmentCredentialsAbsent(token),
    ).not.toThrow();
    expect(() => config.assertEnvironmentCredentialsAbsent(password)).toThrow();
    expect(keyCreated.shape.api_key.safeParse(token).success).toBe(true);
    expect(keyCreated.shape.api_key.safeParse(key).success).toBe(false);
  });
  test("OpenAPI distinguishes primary administration from ledger keys", () => {
    const paths = openapi().paths as Record<string, Record<string, Data>>;
    for (const operation of keyOperations)
      expect(
        paths[operation.path]![operation.method.toLowerCase()]!.security,
      ).toEqual(operation.rootOnly ? [{ staticKey: [] }] : []);
    expect(paths["/v1/catalog"]!.get!.security).toEqual([
      { staticKey: [] },
      { apiKey: [] },
      { browserSession: [] },
    ]);
  });
});
