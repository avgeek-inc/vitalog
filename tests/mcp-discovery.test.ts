import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, describe, expect, test } from "vitest";
import { handleMcp } from "../src/mcp.js";
import { configuration } from "../src/config.js";
import { database } from "../src/db/client.js";
import { object } from "../src/domain/types.js";
import { discoverySchema } from "../src/mcp-schema.js";
import { operations } from "../src/registry/operations.js";
import { Service } from "../src/service.js";
import { examples } from "./fixtures.js";

const addFormats: FormatsPlugin = createRequire(import.meta.url)("ajv-formats");
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
const credential = randomBytes(48).toString("base64url");
const config = configuration({
  AUTH_KEY: credential,
  PUBLIC_BASE_URL: "http://localhost:3000",
  DATABASE_URL: "postgresql://unused.invalid/mcp-discovery-test",
});
const connection = database(config.databaseUrl);
const service = new Service(connection.db, "discovery-test");
const logs: unknown[] = [];
const app = {
  request: (url: string, init?: RequestInit) =>
    handleMcp(
      new Request(url, init),
      service,
      config,
      ["health:read", "health:write"],
      (entry) => logs.push(entry),
    ),
  fetch: (request: Request) =>
    handleMcp(
      request,
      service,
      config,
      ["health:read", "health:write"],
      (entry) => logs.push(entry),
    ),
};
afterAll(() => connection.pool.end());

describe("Portable MCP discovery", () => {
  test("Transport errors identify the rejection without logging request content", async () => {
    logs.length = 0;
    const privateNote = "Private observation that must stay out of logs";
    const response = await app.request("http://localhost:3000/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + credential,
        Host: "localhost:3000",
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "unsupported-test-version",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: privateNote,
        method: "tools/list",
        params: {},
      }),
    });
    expect(response.status).toBe(400);
    expect(logs).toContainEqual({
      event: "mcp_transport_error.unsupported_protocol_version",
      method: "POST",
    });
    expect(JSON.stringify(logs)).not.toContain(privateNote);
    expect(JSON.stringify(logs)).not.toContain(credential);
  });
  test("The official client discovers all tools and validates a catalog result", async () => {
    const client = new Client({ name: "discovery-test", version: "1" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL("http://localhost:3000/mcp"),
          {
            requestInit: {
              headers: {
                Authorization: "Bearer " + credential,
                Host: "localhost:3000",
              },
            },
            fetch: async (input, init) => app.fetch(new Request(input, init)),
          },
        ),
      );
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(
        operations.map((operation) => operation.name),
      );
      const encoded = JSON.stringify(listed);
      expect(Buffer.byteLength(encoded)).toBeLessThan(160 * 1024);
      for (const tool of listed.tools)
        for (const schema of [tool.inputSchema, tool.outputSchema]) {
          expect(schema?.type).toBe("object");
          const text = JSON.stringify(schema);
          expect(Buffer.byteLength(text)).toBeLessThan(16 * 1024);
          expect(text).not.toMatch(/"\$(?:ref|defs|id)"\s*:/);
          expect(ajv.compile(schema!)).toBeTypeOf("function");
        }
      const catalog = await client.callTool({
        name: "health_get_catalog",
        arguments: {},
      });
      expect(catalog.isError).toBeUndefined();
      expect(object(catalog.structuredContent).catalog_version).toBeDefined();
    } finally {
      await client.close();
    }
  });

  test("Summarized inputs accept every record fixture and complete correction variant", () => {
    for (const operation of operations) {
      if (!operation.record_type) continue;
      const fixture = examples[operation.record_type];
      const input = {
        idempotency_key: "discovery-fixture",
        ...(operation.batch ? { records: [fixture] } : fixture),
      };
      operation.input.parse(input);
      const validate = ajv.compile(discoverySchema(operation.input));
      expect(validate(input), JSON.stringify(validate.errors)).toBe(true);
    }
    const correction = operations.find(
      (operation) => operation.name === "health_correct_record",
    )!;
    const validate = ajv.compile(discoverySchema(correction.input));
    for (const [record_type, fixture] of Object.entries(examples)) {
      const input = {
        id: randomUUID(),
        idempotency_key: "discovery-correction",
        expected_version: 1,
        reason: "Supplied correction",
        replacement: { record_type, ...fixture },
      };
      correction.input.parse(input);
      expect(validate(input), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  test("A transport summary cannot bypass full domain validation", async () => {
    const input = {
      metrics: ["measurement:unregistered"],
      start_date: "2026-09-01",
      end_date: "2026-09-10",
    };
    const operation = operations.find(
      (operation) => operation.name === "health_get_trends",
    )!;
    expect(ajv.compile(discoverySchema(operation.input))(input)).toBe(true);
    const response = await app.request("http://localhost:3000/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + credential,
        Host: "localhost:3000",
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "health_get_trends",
          arguments: input,
        },
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text).code).toBe(
      "VALIDATION_ERROR",
    );
  });
});
