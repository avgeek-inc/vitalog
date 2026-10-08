import { vitalogVersion } from "./version.js";
import { errorStatuses } from "./errors.js";
import { operations, restBody } from "./registry/operations.js";
import { jsonSchema } from "./registry/primitives.js";
import type { Data } from "./domain/types.js";
import { keyOperations } from "./auth/contracts.js";
import { oauthPaths } from "./auth/oauth-docs.js";
import { keyManagementOperations } from "./auth/key-management-contracts.js";
import { accountOperations } from "./auth/account-contracts.js";
import { sessionOperations } from "./auth/session-contracts.js";
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
      ...(paths[operation.path] as Data | undefined),
      [operation.method.toLowerCase()]: {
        operationId: operation.name,
        summary: operation.description,
        tags: [operation.record_type ?? "Read"],
        security: [
          { staticKey: [] },
          { apiKey: [] },
          ...(!operation.mutation ? [{ browserSession: [] }] : []),
        ],
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
  for (const operation of keyOperations) {
    const responses: Data = {
      [operation.status]: {
        description: operation.description,
        content: {
          "application/json": { schema: jsonSchema(operation.output) },
        },
      },
    };
    for (const status of [401, 403, 413, 422, 429, 503, 500])
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
    if (operation.name === "revoke_api_key")
      responses["404"] = {
        description: "API key does not exist",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/Error" },
          },
        },
      };
    const parameters: Data[] =
      operation.name === "revoke_api_key"
        ? [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ]
        : operation.name === "list_api_keys"
          ? [
              {
                name: "limit",
                in: "query",
                schema: {
                  type: "integer",
                  minimum: 1,
                  maximum: 100,
                  default: 50,
                },
              },
              {
                name: "offset",
                in: "query",
                schema: {
                  type: "integer",
                  minimum: 0,
                  maximum: 1_000_000,
                  default: 0,
                },
              },
            ]
          : [];
    if (operation.name === "create_api_key")
      parameters.push({
        name: "Idempotency-Key",
        in: "header",
        required: false,
        schema: { type: "string", format: "uuid" },
        description:
          "Reuse with identical settings for safe retries; replay returns api_key null.",
      });
    const body =
      operation.name === "create_api_key"
        ? (jsonSchema(operation.input) as Data)
        : undefined;
    if (body) {
      const properties = body.properties as Data;
      properties.password = {
        ...(properties.password as Data),
        format: "password",
        writeOnly: true,
        maxLength: 256,
        description:
          "ROOT_PASSWORD; at most 256 UTF-8 bytes. Used only for this request.",
      };
    }
    paths[operation.path] = {
      ...(paths[operation.path] as Data | undefined),
      [operation.method.toLowerCase()]: {
        operationId: operation.name,
        summary: operation.description,
        tags: ["API keys"],
        security: operation.rootOnly ? [{ staticKey: [] }] : [],
        parameters,
        ...(body
          ? {
              requestBody: {
                required: true,
                content: { "application/json": { schema: body } },
              },
            }
          : {}),
        responses,
      },
    };
  }
  for (const operation of accountOperations) {
    paths[operation.path] = {
      [operation.method.toLowerCase()]: {
        operationId: operation.name,
        summary: operation.description,
        tags: ["Account settings"],
        security: [{ browserSession: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: jsonSchema(operation.input) },
          },
        },
        responses: {
          "200": {
            description: operation.description,
            content: {
              "application/json": { schema: jsonSchema(operation.output) },
            },
          },
          ...Object.fromEntries(
            [401, 403, 413, 422, 429, 500, 503].map((status) => [
              status,
              {
                description: "Authentication or request validation failed",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Error" },
                  },
                },
              },
            ]),
          ),
        },
      },
    };
  }
  for (const operation of sessionOperations) {
    const responses: Data = {
      [operation.status]: {
        description: operation.description,
        content: {
          "application/json": { schema: jsonSchema(operation.output) },
        },
      },
    };
    for (const status of [401, 403, 413, 422, 429, 503, 500])
      responses[String(status)] = {
        description: "Authentication or request validation failed",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/Error" },
          },
        },
      };
    paths[operation.path] = {
      ...(paths[operation.path] as Data | undefined),
      [operation.method.toLowerCase()]: {
        operationId: operation.name,
        summary: operation.description,
        tags: ["Browser sessions"],
        security: operation.method === "POST" ? [] : [{ browserSession: [] }],
        ...(operation.method === "POST"
          ? {
              requestBody: {
                required: true,
                content: {
                  "application/json": { schema: jsonSchema(operation.input) },
                },
              },
            }
          : {}),
        responses,
      },
    };
  }
  for (const operation of keyManagementOperations) {
    const parameters: Data[] = operation.path.includes("{id}")
      ? [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ]
      : operation.name === "list_managed_api_keys"
        ? [
            {
              name: "limit",
              in: "query",
              schema: {
                type: "integer",
                minimum: 1,
                maximum: 100,
                default: 50,
              },
            },
            {
              name: "offset",
              in: "query",
              schema: {
                type: "integer",
                minimum: 0,
                maximum: 1000000,
                default: 0,
              },
            },
          ]
        : [];
    if (operation.name === "create_managed_api_key")
      parameters.push({
        name: "Idempotency-Key",
        in: "header",
        required: false,
        schema: { type: "string", format: "uuid" },
        description:
          "Reuse with identical settings for safe retries; replay returns api_key null.",
      });
    const credentials = "credentials" in operation;
    paths[operation.path] = {
      ...(paths[operation.path] as Data | undefined),
      [operation.method.toLowerCase()]: {
        operationId: operation.name,
        summary: operation.description,
        tags: ["Key management"],
        security: credentials
          ? []
          : [
              { keyManagementSession: [] },
              ...(operation.name === "list_managed_api_keys"
                ? [{ browserSession: [] }]
                : []),
            ],
        parameters,
        ...("input" in operation && operation.method === "POST"
          ? {
              requestBody: {
                required: true,
                content: {
                  "application/json": { schema: jsonSchema(operation.input) },
                },
              },
            }
          : {}),
        responses: {
          [operation.status]: {
            description: operation.description,
            content: {
              "application/json": { schema: jsonSchema(operation.output) },
            },
          },
          ...Object.fromEntries(
            [401, 403, 404, 413, 422, 429, 500, 503].map((status) => [
              status,
              {
                description: "Authentication or request validation failed",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Error" },
                  },
                },
              },
            ]),
          ),
        },
      },
    };
  }
  paths["/api-keys"] = {
    get: {
      summary: "Redirect to the separate API-key creation UI",
      security: [],
      responses: {
        "302": {
          description: "Redirect to UI_BASE_URL/api-keys",
          headers: { Location: { schema: { type: "string", format: "uri" } } },
        },
        "404": { description: "UI_BASE_URL is not configured" },
      },
    },
  };
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
      security: [{ staticKey: [] }, { apiKey: [] }],
      responses: {
        "200": { description: "Ready" },
        "503": { description: "Unavailable" },
      },
    },
  };
  paths["/openapi.json"] = {
    get: {
      summary: "Authenticated OpenAPI document",
      security: [{ staticKey: [] }, { apiKey: [] }],
      responses: { "200": { description: "OpenAPI 3.1.1" } },
    },
  };
  return {
    openapi: "3.1.1",
    info: {
      title: "Vitalog",
      version: vitalogVersion,
      description:
        "Single-user structured observations with equivalent REST and MCP domain services. Environment AUTH_KEY or revocable personal Bearer keys with required name, permissions and explicit expiry (including Never); Primary key management requires AUTH_KEY; the UI uses separate, root-verified 30-minute management sessions. MCP clients use OAuth authorization code with S256 PKCE, issued after root sign-in. Clients are resolved through HTTPS metadata, pre-registration or dynamic registration. OAuth tokens grant MCP access only.",
    },
    servers: [
      {
        url: "https://vitalog-api.example.com",
        description: "Production REST and MCP API",
      },
      {
        url: "http://localhost:3000",
        description: "Loopback development; production requires TLS ingress",
      },
    ],
    paths: { ...paths, ...oauthPaths },
    components: {
      securitySchemes: {
        keyManagementSession: {
          type: "http",
          scheme: "bearer",
          description:
            "Opaque vlm_ token valid for 30 minutes. API-key management only; ledger and MCP routes reject it. The UI stores it in a separate host-only HttpOnly cookie.",
        },
        browserSession: {
          type: "http",
          scheme: "bearer",
          description:
            "Opaque vls_ browser token, valid for 30 days unless revoked. Read-only REST access. The UI stores it in a host-only HttpOnly SameSite=Lax cookie; it never reaches browser JavaScript. Key administration and MCP reject this token.",
        },
        oauthFlowCookie: {
          type: "apiKey",
          in: "cookie",
          name: "__Secure-vitalog-oauth",
          description:
            "Signed HttpOnly consent-flow cookie from /oauth/authorize, valid for five minutes. Loopback development uses vitalog-oauth.",
        },
        staticKey: {
          type: "http",
          scheme: "bearer",
          description:
            "Environment AUTH_KEY. Full ledger access and primary API-key administration. Not OAuth or JWT.",
        },
        apiKey: {
          type: "http",
          scheme: "bearer",
          description:
            "Generated opaque vlk_ key with a required name, explicit read/edit permissions, optional administrative inspection and chosen expiry (including Never). Enforces the same ceiling on REST and MCP; cannot administer credentials or account settings. Not OAuth or JWT.",
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
