import { randomBytes } from "node:crypto";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { application } from "../src/app.js";
import { configuration } from "../src/config.js";
import { database } from "../src/db/client.js";
import { DomainError, parse } from "../src/errors.js";
import { operationByName } from "../src/registry/operations.js";
import { CATALOG_VERSION } from "../src/registry/definitions.js";
import { inspectBody, MAX_REQUEST_BYTES } from "../src/security.js";
import { Service } from "../src/service.js";
import { examples, record } from "./fixtures.js";

const key = randomBytes(48).toString("base64url");
const config = configuration({
  AUTH_KEY: key,
  DATABASE_URL: "postgresql://unused.invalid/security-unit-test",
});
const connection = database(config.databaseUrl);
const service = new Service(
  connection.db,
  config.timezone,
  config.authDigest.toString("hex"),
);
const original = service.execute.bind(service);
const execute = vi
  .spyOn(service, "execute")
  .mockImplementation(async (name, input) => {
    if (name === "health_get_catalog") return original(name, input);
    parse(operationByName.get(name)!.input, input);
    return { accepted: true };
  });
const logs: unknown[] = [];
const app = application(service, config, (entry) => logs.push(entry));
const headers = { Authorization: `Bearer ${key}`, Host: "localhost:3000" };
const encodeJsonSecret = (text: string) =>
  text.replaceAll(
    key,
    [...key]
      .map(
        (character) =>
          `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
      )
      .join(""),
  );
async function rejected(response: Response) {
  expect(response.status).toBe(422);
  const text = await response.text();
  expect(text.includes(key)).toBe(false);
  expect(JSON.parse(text).code).toBe("VALIDATION_ERROR");
  expect(execute.mock.calls.length).toBe(0);
  expect(JSON.stringify(logs).includes(key)).toBe(false);
}
function post(
  path: string,
  body: string,
  extraHeaders: Record<string, string> = {},
) {
  return app.request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      "Idempotency-Key": "unit-security-write",
      ...extraHeaders,
    },
    body,
  });
}
beforeEach(() => {
  execute.mockClear();
  logs.length = 0;
});
afterAll(() => connection.pool.end());

describe("Configured credential stays outside domain data", () => {
  test("Raw query text is guarded before plus-sign form decoding", async () => {
    const plusKey = `${randomBytes(48).toString("base64url")}+`;
    const plusConfig = configuration({
      AUTH_KEY: plusKey,
      DATABASE_URL: config.databaseUrl,
    });
    const plusApp = application(service, plusConfig, () => {});
    const response = await plusApp.request(
      `http://localhost:3000/v1/catalog?query=${plusKey}`,
      {
        headers: { Authorization: `Bearer ${plusKey}`, Host: "localhost:3000" },
      },
    );
    expect(response.status).toBe(422);
    expect((await response.text()).includes(plusKey)).toBe(false);
    expect(execute.mock.calls.length).toBe(0);
  });
  test.each(["source_description", "source_locator", "assumptions"])(
    "REST rejects admitted provenance %s before validation or mutation",
    async (field) => {
      const body = {
        ...examples.nutrition,
        provenance: {
          ...examples.nutrition.provenance,
          [field]:
            field === "assumptions"
              ? [`prefix ${key} suffix`]
              : `prefix ${key} suffix`,
        },
      };
      await rejected(await post("/v1/nutrition", JSON.stringify(body)));
    },
  );
  test.each([false, true])(
    "REST rejects notes, including JSON escapes: %s",
    async (escaped) => {
      const text = JSON.stringify({
        ...examples.nutrition,
        data: { ...examples.nutrition.data, notes: `prefix ${key} suffix` },
      });
      await rejected(
        await post("/v1/nutrition", escaped ? encodeJsonSecret(text) : text),
      );
    },
  );
  test("The idempotency header cannot persist the configured credential", async () => {
    await rejected(
      await post("/v1/nutrition", JSON.stringify(examples.nutrition), {
        "Idempotency-Key": key,
      }),
    );
  });
  test.each([false, true])(
    "Unknown property names cannot reflect the credential: %s",
    async (escaped) => {
      const text = JSON.stringify({ ...examples.nutrition, [key]: "unknown" });
      await rejected(
        await post("/v1/nutrition", escaped ? encodeJsonSecret(text) : text),
      );
    },
  );
  test.each(["name", "value"])(
    "Decoded query %s cannot reflect the credential",
    async (target) => {
      const query = new URLSearchParams(
        target === "name"
          ? { [key]: "unknown" }
          : { query: `prefix ${key} suffix` },
      );
      await rejected(
        await app.request(`http://localhost:3000/v1/catalog?${query}`, {
          headers,
        }),
      );
    },
  );
  test.each([false, true])(
    "Path credentials are rejected after URL decoding: %s",
    async (encoded) => {
      const value = encoded
        ? [...key]
            .map((character) => `%${character.charCodeAt(0).toString(16)}`)
            .join("")
        : key;
      await rejected(
        await app.request(`http://localhost:3000/v1/records/${value}`, {
          headers,
        }),
      );
    },
  );
  test.each(["reason", "replacement"])(
    "Corrections guard the %s before mutation",
    async (field) => {
      const body =
        field === "reason"
          ? {
              expected_version: 1,
              reason: `prefix ${key} suffix`,
              replacement: { record_type: "nutrition", ...examples.nutrition },
            }
          : {
              expected_version: 1,
              reason: "Supplied correction",
              replacement: {
                record_type: "nutrition",
                ...examples.nutrition,
                data: { ...examples.nutrition.data, notes: key },
              },
            };
      await rejected(
        await post(
          "/v1/records/11111111-1111-4111-8111-111111111111/corrections",
          JSON.stringify(body),
        ),
      );
    },
  );
  test.each(["MCP-Protocol-Version", "Mcp-Session-Id", "Cookie"])(
    "Transport %s cannot expose the credential",
    async (header) => {
      await rejected(await post("/mcp", "{}", { [header]: key }));
    },
  );
  test.each([false, true])(
    "MCP rejects an admitted note before SDK processing: %s",
    async (escaped) => {
      const text = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "health_log_nutrition",
          arguments: {
            idempotency_key: "security-mcp",
            ...examples.nutrition,
            data: { ...examples.nutrition.data, notes: key },
          },
        },
      });
      await rejected(
        await post("/mcp", escaped ? encodeJsonSecret(text) : text),
      );
    },
  );
  test("Malformed MCP JSON cannot reflect an escaped credential string", async () => {
    await rejected(await post("/mcp", encodeJsonSecret(`{"${key}": "value",`)));
  });
  test("Configured secret is omitted when configuration is serialized", () => {
    expect(JSON.stringify(config).includes(key)).toBe(false);
  });
  test.each(["REST", "MCP"])(
    "A restored credential-bearing %s response is blocked without redacting data",
    async (transport) => {
      const snapshot = record("nutrition", {
        ...examples.nutrition.data,
        notes: key,
      });
      execute.mockResolvedValueOnce({
        catalog_version: CATALOG_VERSION,
        record: snapshot,
      });
      const response =
        transport === "REST"
          ? await app.request(
              `http://localhost:3000/v1/records/${snapshot.id}`,
              { headers },
            )
          : await post(
              "/mcp",
              JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: {
                  name: "health_get_record",
                  arguments: { id: snapshot.id },
                },
              }),
              { Accept: "application/json, text/event-stream" },
            );
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text.includes(key)).toBe(false);
      expect(JSON.parse(text).code).toBe("INTERNAL_ERROR");
    },
  );
  test("An unexpected error cannot reflect a configured credential", async () => {
    execute.mockRejectedValueOnce(
      new DomainError("VALIDATION_ERROR", `Unexpected ${key}`),
    );
    const response = await app.request("http://localhost:3000/v1/catalog", {
      headers,
    });
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text.includes(key)).toBe(false);
    expect(JSON.parse(text).code).toBe("INTERNAL_ERROR");
  });
});

describe("Guard preserves ordinary contracts and request bounds", () => {
  test("Body inspection preserves a chunked request and its exact text", async () => {
    const text = JSON.stringify({
      notes: "Supplied reading: \u00b5g and normal JSON escaping",
    });
    const bytes = new TextEncoder().encode(text);
    const requestInit = {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 18));
          controller.enqueue(bytes.slice(18));
          controller.close();
        },
      }),
      duplex: "half",
    };
    const request = new Request("http://localhost:3000/mcp", requestInit);
    await inspectBody(request, config.assertCredentialAbsent);
    expect(request.bodyUsed).toBe(false);
    expect(await request.text()).toBe(text);
  });
  test("An ordinary REST record reaches the same input contract unchanged", async () => {
    const body = {
      ...examples.nutrition,
      data: { ...examples.nutrition.data, notes: "Supplied bounded note" },
    };
    const response = await post("/v1/nutrition", JSON.stringify(body));
    expect(response.status).toBe(200);
    const [, input] = execute.mock.calls[0]!;
    expect(JSON.stringify(input)).toBe(
      JSON.stringify({ ...body, idempotency_key: "unit-security-write" }),
    );
  });
  test.each(["initialize", "tools/list", "tools/call"])(
    "SDK %s still consumes its original request",
    async (method) => {
      const params =
        method === "initialize"
          ? {
              protocolVersion: "2025-11-25",
              capabilities: {},
              clientInfo: { name: "security-unit", version: "1.0.0" },
            }
          : method === "tools/call"
            ? { name: "health_get_catalog", arguments: {} }
            : {};
      const response = await post(
        "/mcp",
        JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        {
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-11-25",
        },
      );
      expect(response.status).toBe(200);
      const result = (await response.json()).result;
      expect(result).toBeDefined();
      if (method === "tools/list") expect(result.tools.length).toBe(16);
      if (method === "tools/call")
        expect(result.structuredContent.catalog_version).toBe(CATALOG_VERSION);
    },
  );
  test("Body bound is enforced despite an incorrect small Content-Length", async () => {
    const response = await post("/mcp", "x".repeat(MAX_REQUEST_BYTES + 1), {
      "Content-Length": "1",
    });
    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe("LIMIT_EXCEEDED");
    expect(execute.mock.calls.length).toBe(0);
  });
  test("Prototype-named query arguments remain unknown fields", async () => {
    const response = await app.request(
      "http://localhost:3000/v1/catalog?__proto__=unknown",
      { headers },
    );
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe("VALIDATION_ERROR");
  });
  test("Prototype-named JSON fields cannot disappear during argument construction", async () => {
    const body = JSON.parse(JSON.stringify(examples.nutrition));
    Object.defineProperty(body, "__proto__", {
      value: { hidden: "unknown" },
      enumerable: true,
    });
    const response = await post("/v1/nutrition", JSON.stringify(body));
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe("VALIDATION_ERROR");
  });
});
