import { errorStatuses } from "./errors.js";
import { operations, restBody } from "./registry/operations.js";
import { jsonSchema } from "./registry/primitives.js";
import type { Data } from "./domain/types.js";
export function openapi(): Data {
  const paths: Data = {};
  for (const operation of operations) {
    const pathNames = [...operation.path.matchAll(/\{([^}]+)\}/g)].map(
      (match) => match[1]!,
    );
    const inputSchema = jsonSchema(operation.input) as Data;
    const properties = inputSchema.properties as Data;
    const parameters: Data[] = pathNames.map((name) => ({
      name,
      in: "path",
      required: true,
      schema: jsonSchema(operation.input.shape[name]!),
    }));
    if (operation.method === "GET")
      for (const key of Object.keys(properties)) {
        if (pathNames.includes(key)) continue;
        parameters.push({
          name: key,
          in: "query",
          required: (
            (inputSchema.required as string[] | undefined) ?? []
          ).includes(key),
          schema: jsonSchema(operation.input.shape[key]!),
          ...(key === "metrics" || key === "record_types" || key === "sections"
            ? { style: "form", explode: false }
            : {}),
          description:
            "Exactly one parameter; booleans are true/false, arrays are comma-separated. Empty values are rejected.",
        });
      }
    if (operation.mutation)
      parameters.push({
        name: "Idempotency-Key",
        in: "header",
        required: true,
        schema: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
        },
      });
    const responses: Data = {
      "200": {
        description: operation.mutation
          ? "Committed mutation or durable idempotent replay"
          : "Successful domain response",
        content: {
          "application/json": {
            schema: {
              ...jsonSchema(operation.output),
              $id: `urn:vitalog:${operation.name}:response`,
            },
          },
        },
      },
    };
    for (const status of [...new Set(Object.values(errorStatuses))])
      responses[String(status)] = {
        description: Object.entries(errorStatuses)
          .filter(([, code]) => code === status)
          .map(([name]) => name)
          .join(", "),
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/Error" },
          },
        },
      };
    paths[operation.path] = {
      [operation.method.toLowerCase()]: {
        operationId: operation.name,
        summary: operation.description,
        tags: [operation.record_type ?? "Read"],
        security: [{ staticKey: [] }],
        parameters,
        ...(operation.method === "POST"
          ? {
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: {
                      ...jsonSchema(restBody(operation)),
                      $id: `urn:vitalog:${operation.name}:request`,
                    },
                  },
                },
              },
            }
          : {}),
        responses,
      },
    };
  }
  paths["/healthz"] = {
    get: {
      summary: "Minimal liveness",
      security: [],
      responses: { "200": { description: "Process is live" } },
    },
  };
  paths["/readyz"] = {
    get: {
      summary: "Authenticated database and migration readiness",
      security: [{ staticKey: [] }],
      responses: {
        "200": { description: "Ready" },
        "503": { description: "Unavailable" },
      },
    },
  };
  paths["/openapi.json"] = {
    get: {
      summary: "Authenticated OpenAPI document",
      security: [{ staticKey: [] }],
      responses: { "200": { description: "OpenAPI 3.1.1" } },
    },
  };
  return {
    openapi: "3.1.1",
    info: {
      title: "Vitalog",
      version: "1.0.0",
      description:
        "Single-user structured observations with equivalent REST and MCP domain services. Opaque static Bearer secret; no OAuth or JWT.",
    },
    servers: [
      {
        url: "http://localhost:3000",
        description: "Loopback development; production requires TLS ingress",
      },
    ],
    paths,
    components: {
      securitySchemes: {
        staticKey: {
          type: "http",
          scheme: "bearer",
          description:
            "Operator-supplied AUTH_KEY; opaque static secret, not OAuth or JWT",
        },
      },
      schemas: {
        Error: {
          type: "object",
          additionalProperties: false,
          required: ["code", "message", "catalog_version", "issues"],
          properties: {
            code: { type: "string", enum: Object.keys(errorStatuses) },
            message: { type: "string" },
            catalog_version: { type: "string" },
            issues: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  reason: { type: "string" },
                  message: { type: "string" },
                  suggested_keys: { type: "array", items: { type: "string" } },
                  discovery: { type: "object" },
                },
              },
            },
            existing_id: { type: "string" },
            current_version: { type: "integer" },
            current_catalog_version: { type: "string" },
          },
        },
      },
    },
    "x-mcp": {
      endpoint: "/mcp",
      transport: "Streamable HTTP",
      sdk: "@modelcontextprotocol/sdk@1.31.0",
      authentication: "Same Authorization Bearer header on every request",
    },
  };
}
