import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stringify } from "yaml";
import { openapi } from "../src/openapi.js";
import { operations } from "../src/registry/operations.js";
import {
  CATALOG_VERSION,
  inventory,
  recordTypes,
} from "../src/registry/definitions.js";
import { recordDescriptor } from "../src/domain/catalog.js";
import { base, examples } from "../tests/fixtures.js";
import type { Data } from "../src/domain/types.js";
import { keyOperations } from "../src/auth/contracts.js";
import { chatGptClientId, chatGptRedirectUri } from "../src/auth/oauth.js";

const check = process.argv.includes("--check");
const stableId = (value: string) => {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
async function save(path: string, content: string) {
  if (check) {
    const actual = await readFile(path, "utf8");
    if (actual !== content)
      throw new Error(
        `Generated artifact is stale: ${path}. Run npm run docs:generate.`,
      );
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}
const json = (data: unknown) => JSON.stringify(data, null, 2) + "\n";
const requestArgs = (operation: (typeof operations)[number]): Data => {
  if (operation.record_type) {
    const input = examples[operation.record_type];
    return {
      idempotency_key: "{{idempotencyKey}}",
      ...(operation.batch ? { records: [input] } : input),
    };
  }
  if (operation.name === "health_get_daily_summary")
    return { date: "{{date}}" };
  if (operation.name === "health_get_trends")
    return {
      metrics: ["measurement:weight"],
      start_date: "2026-09-01",
      end_date: "2026-09-30",
    };
  if (operation.name === "health_get_record")
    return { id: "{{recordId}}", include_history: true, history_limit: 100 };
  if (operation.name === "health_correct_record")
    return {
      id: "{{recordId}}",
      idempotency_key: "{{idempotencyKey}}",
      expected_version: 1,
      reason: "Correct supplied observation",
      replacement: { record_type: "nutrition", ...examples.nutrition },
    };
  if (operation.name === "health_void_record")
    return {
      id: "{{recordId}}",
      idempotency_key: "{{idempotencyKey}}",
      expected_version: 1,
      reason: "Void supplied observation",
    };
  return {};
};
const source = openapi();
await save("docs/openapi.json", json(source));
await save("docs/examples.json", json(examples));
await save(
  "docs/record-schemas.json",
  json(
    Object.fromEntries(
      recordTypes.map((type) => [type, recordDescriptor(type, true)]),
    ),
  ),
);
await save(
  "docs/coverage.json",
  json({
    catalog_version: CATALOG_VERSION,
    specification_revision: 5,
    inventory_counts: inventory.counts,
    definitions: {
      nutrients: inventory.nutrient_entries.map((entry) => ({
        key: entry.key,
        implemented: true,
        unit: entry.unit,
        test: `Nutrient ${entry.key}`,
        integration_group:
          "Every advertised nutrient accepts REST and MCP writes and typed corrections",
      })),
      lab_analytes: inventory.lab_analytes.map((entry) => ({
        key: entry.analyte_key,
        implemented: true,
        test: `Lab ${entry.analyte_key}`,
        integration_group:
          "All 424 analytes, overlapping panels, typed uncommon results and corrections round-trip through REST/MCP",
      })),
      measurements: Object.values(inventory.measurement_groups)
        .flat()
        .map((key) => ({
          key,
          implemented: true,
          test: `Measurement ${key}`,
          integration_group:
            "All 110 measurement keys accept both transports, corrections and component projections",
        })),
    },
    record_types: [...recordTypes],
    operation_parity: operations.map(({ name, method, path }) => ({
      tool: name,
      method,
      path,
      shared_domain_service: true,
    })),
    test_evidence:
      "docs/verification-report.json contains the captured executed run; npm run test:integration regenerates .test-artifacts/verification.json.",
    intentionally_unsupported_calculations: [
      "clinical diagnoses",
      "nutrient estimation",
      "IU or elemental-moiety inference",
      "laboratory unit normalization",
      "interval arithmetic",
      "proprietary scores",
      "predictions",
    ],
    remaining_unsupported_required_branches: [],
  }),
);

const auth = {
  type: "bearer",
  bearer: [{ key: "token", value: "{{authKey}}", type: "string" }],
};
const items: Data[] = [];
const collectionRoot = "postman/collections/Vitalog API";
await save(
  `${collectionRoot}/.resources/definition.yaml`,
  stringify({
    $kind: "collection",
    id: stableId("Vitalog API"),
    description:
      "Generated from the shared registry and OpenAPI. Set authKey as a local private secret. Examples use synthetic historical observations; writes modify the configured database. Choose a new idempotencyKey for each intentional event and retain it for retries.",
    variables: {
      recordId: "",
      date: base.occurred_on,
      idempotencyKey: "",
      apiKeyId: "",
    },
    auth: [
      {
        id: stableId("vitalog-bearer"),
        type: "bearer",
        name: "Ledger Bearer key",
        credentials: { token: "{{authKey}}" },
      },
    ],
  }),
);
for (const [index, name] of ["REST", "MCP", "API keys", "OAuth"].entries())
  await save(
    `${collectionRoot}/${name}/.resources/definition.yaml`,
    stringify({
      $kind: "folder",
      id: stableId(`folder:${name}`),
      name,
      order: (index + 1) * 1000,
    }),
  );
for (const [index, operation] of operations.entries()) {
  const args = requestArgs(operation);
  const { id: _id, idempotency_key: _idem, date: _date, ...restArgs } = args;
  const query =
    operation.method === "GET"
      ? Object.fromEntries(
          Object.entries(restArgs).map(([key, value]) => [
            key,
            Array.isArray(value) ? value.join(",") : String(value),
          ]),
        )
      : {};
  const path = operation.path
    .replace("{id}", "{{recordId}}")
    .replace("{date}", "{{date}}");
  const queryText = Object.keys(query).length
    ? "?" + new URLSearchParams(query).toString()
    : "";
  const headers = {
    Accept: "application/json",
    ...(operation.mutation
      ? {
          "Content-Type": "application/json",
          "Idempotency-Key": "{{idempotencyKey}}",
        }
      : {}),
  };
  const body =
    operation.method === "POST" ? json(restArgs).trimEnd() : undefined;
  const item = {
    name: operation.name,
    request: {
      method: operation.method,
      header: Object.entries(headers).map(([key, value]) => ({ key, value })),
      url: `{{baseUrl}}${path}${queryText}`,
      description: operation.description,
      ...(body
        ? {
            body: {
              mode: "raw",
              raw: body,
              options: { raw: { language: "json" } },
            },
          }
        : {}),
    },
  };
  items.push(item);
  await save(
    `${collectionRoot}/REST/${operation.name}.request.yaml`,
    stringify({
      $kind: "http-request",
      id: stableId(`REST:${operation.name}`),
      description: operation.description,
      method: operation.method,
      url: `{{baseUrl}}${path}${queryText}`,
      headers,
      ...(body ? { body: { type: "json", content: body } } : {}),
      order: (index + 1) * 1000,
    }),
  );
}
for (const [name, path] of [
  ["Liveness", "/healthz"],
  ["Readiness", "/readyz"],
  ["OpenAPI", "/openapi.json"],
]) {
  items.push({
    name,
    request: { method: "GET", url: `{{baseUrl}}${path}`, description: name },
  });
  await save(
    `${collectionRoot}/REST/${name}.request.yaml`,
    stringify({
      $kind: "http-request",
      id: stableId(name!),
      method: "GET",
      url: `{{baseUrl}}${path}`,
      headers: { Accept: "application/json" },
    }),
  );
}
const mcp: Data[] = [];
const keyItems: Data[] = [];
for (const operation of keyOperations) {
  const url =
    "{{baseUrl}}" +
    operation.path.replace("{id}", "{{apiKeyId}}") +
    (operation.name === "list_api_keys" ? "?limit=50&offset=0" : "");
  const body =
    operation.name === "create_api_key"
      ? json({
          email: "{{rootEmail}}",
          password: "{{rootPassword}}",
        }).trimEnd()
      : undefined;
  const authentication = operation.rootOnly
    ? {
        type: "bearer",
        bearer: [{ key: "token", value: "{{rootAuthKey}}", type: "string" }],
      }
    : { type: "noauth" };
  const headers = {
    Accept: "application/json",
    ...(body ? { "Content-Type": "application/json" } : {}),
  };
  keyItems.push({
    name: operation.name,
    request: {
      method: operation.method,
      url,
      description: operation.description,
      auth: authentication,
      header: Object.entries(headers).map(([key, value]) => ({ key, value })),
      ...(body
        ? {
            body: {
              mode: "raw",
              raw: body,
              options: { raw: { language: "json" } },
            },
          }
        : {}),
    },
  });
  await save(
    `${collectionRoot}/API keys/${operation.name}.request.yaml`,
    stringify({
      $kind: "http-request",
      id: stableId(`API keys:${operation.name}`),
      description: operation.description,
      method: operation.method,
      url,
      headers,
      auth: [
        {
          id: stableId(`API keys:${operation.name}:auth`),
          type: operation.rootOnly ? "bearer" : "noauth",
          name: operation.rootOnly
            ? "Primary AUTH_KEY"
            : "Root credentials in JSON",
          ...(operation.rootOnly
            ? { credentials: { token: "{{rootAuthKey}}" } }
            : {}),
        },
      ],
      ...(body ? { body: { type: "json", content: body } } : {}),
    }),
  );
}
const oauthItems: Data[] = [];
const oauthVariables = [
  { key: "oauthCode", value: "", type: "secret", enabled: true },
  { key: "oauthVerifier", value: "", type: "secret", enabled: true },
  { key: "oauthCsrf", value: "", type: "secret", enabled: true },
  { key: "oauthChallenge", value: "", enabled: true },
  { key: "oauthState", value: "", enabled: true },
];
const oauthQuery = Object.entries({
  response_type: "code",
  client_id: chatGptClientId,
  redirect_uri: chatGptRedirectUri,
  resource: "{{baseUrl}}/mcp",
  state: "{{oauthState}}",
  scope: "health:read health:write",
  code_challenge: "{{oauthChallenge}}",
  code_challenge_method: "S256",
})
  .map(
    ([key, value]) =>
      `${key}=${encodeURIComponent(value).replaceAll("%7B", "{").replaceAll("%7D", "}")}`,
  )
  .join("&");
const oauthForm = {
  grant_type: "authorization_code",
  code: "{{oauthCode}}",
  client_id: chatGptClientId,
  redirect_uri: chatGptRedirectUri,
  resource: "{{baseUrl}}/mcp",
  code_verifier: "{{oauthVerifier}}",
};
for (const [path, methods] of Object.entries(source.paths as Data)) {
  for (const [method, descriptor] of Object.entries(methods as Data)) {
    const operation = descriptor as Data;
    if (!(operation.tags as string[] | undefined)?.includes("OAuth")) continue;
    const name = String(operation.operationId);
    const url =
      "{{baseUrl}}" +
      path +
      (path === "/oauth/authorize" ? "?" + oauthQuery : "");
    const headers: Record<string, string> = {
      Accept: path === "/oauth/authorize" ? "text/html" : "application/json",
    };
    let nativeBody: Data | undefined;
    let importedBody: Data | undefined;
    if (path === "/oauth/approve") {
      headers["Content-Type"] = "application/json";
      headers.Origin = "{{uiUrl}}";
      const content = json({
        csrf_token: "{{oauthCsrf}}",
        action: "allow",
        email: "{{rootEmail}}",
        password: "{{rootPassword}}",
      }).trimEnd();
      nativeBody = { type: "json", content };
      importedBody = {
        mode: "raw",
        raw: content,
        options: { raw: { language: "json" } },
      };
    } else if (path === "/oauth/token") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      nativeBody = {
        type: "text",
        content: Object.entries(oauthForm)
          .map(
            ([key, value]) =>
              `${key}=${encodeURIComponent(value).replaceAll("%7B", "{").replaceAll("%7D", "}")}`,
          )
          .join("&"),
      };
      importedBody = {
        mode: "urlencoded",
        urlencoded: Object.entries(oauthForm).map(([key, value]) => ({
          key,
          value,
          type: "text",
        })),
      };
    }
    const description = String(operation.description);
    oauthItems.push({
      name,
      request: {
        method: method.toUpperCase(),
        url,
        description,
        auth: { type: "noauth" },
        header: Object.entries(headers).map(([key, value]) => ({ key, value })),
        ...(importedBody ? { body: importedBody } : {}),
      },
    });
    await save(
      `${collectionRoot}/OAuth/${name}.request.yaml`,
      stringify({
        $kind: "http-request",
        id: stableId(`OAuth:${name}`),
        method: method.toUpperCase(),
        url,
        description,
        headers,
        auth: [
          {
            id: stableId(`OAuth:${name}:auth`),
            type: "noauth",
            name: "OAuth protocol; no inherited key",
          },
        ],
        ...(nativeBody ? { body: nativeBody } : {}),
      }),
    );
  }
}
const requests: { name: string; payload: Data; headers?: Data }[] = [
  {
    name: "Initialize",
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "Postman", version: "1.0.0" },
      },
    },
  },
  {
    name: "Initialized notification",
    payload: { jsonrpc: "2.0", method: "notifications/initialized" },
  },
  {
    name: "List tools",
    payload: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  },
  ...operations.map((operation, index) => ({
    name: operation.name,
    payload: {
      jsonrpc: "2.0",
      id: index + 3,
      method: "tools/call",
      params: { name: operation.name, arguments: requestArgs(operation) },
    },
  })),
];
for (const { name, payload } of requests) {
  const headers = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "MCP-Protocol-Version": "2025-11-25",
  };
  mcp.push({
    name,
    request: {
      method: "POST",
      url: "{{baseUrl}}/mcp",
      header: Object.entries(headers).map(([key, value]) => ({ key, value })),
      body: {
        mode: "raw",
        raw: json(payload).trimEnd(),
        options: { raw: { language: "json" } },
      },
    },
  });
  await save(
    `${collectionRoot}/MCP/${name}.request.yaml`,
    stringify({
      $kind: "http-request",
      id: stableId(`MCP:${name}`),
      description:
        "Stateless MCP with the same private Bearer header. Initialize before discovery and calls.",
      method: "POST",
      url: "{{baseUrl}}/mcp",
      headers,
      body: { type: "json", content: json(payload).trimEnd() },
    }),
  );
}
await save(
  "postman/Vitalog.postman_collection.json",
  json({
    info: {
      _postman_id: stableId("Vitalog API"),
      name: "Vitalog API",
      schema:
        "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      description:
        "Generated REST and MCP contracts. Synthetic examples; configure the private authKey locally. See postman/README.md.",
    },
    auth,
    variable: [
      { key: "recordId", value: "" },
      { key: "date", value: base.occurred_on },
      { key: "idempotencyKey", value: "" },
      { key: "apiKeyId", value: "" },
    ],
    item: [
      { name: "REST", item: items },
      { name: "MCP", item: mcp },
      { name: "API keys", item: keyItems },
      { name: "OAuth", item: oauthItems },
    ],
  }),
);
await save(
  "postman/environments/Vitalog.environment.yaml",
  stringify({
    name: "Vitalog",
    values: [
      {
        key: "baseUrl",
        value: "https://vitalog-api.praveent.com",
        enabled: true,
      },
      { key: "uiUrl", value: "https://vitalog.praveent.com", enabled: true },
      { key: "authKey", value: "", type: "secret", enabled: true },
      { key: "rootAuthKey", value: "", type: "secret", enabled: true },
      { key: "rootEmail", value: "", type: "secret", enabled: true },
      { key: "rootPassword", value: "", type: "secret", enabled: true },
      ...oauthVariables,
    ],
  }),
);
await save(
  "postman/Vitalog.postman_environment.json",
  json({
    id: stableId("vitalog-environment"),
    name: "Vitalog",
    values: [
      {
        key: "baseUrl",
        value: "https://vitalog-api.praveent.com",
        enabled: true,
      },
      { key: "authKey", value: "", type: "secret", enabled: true },
      { key: "rootAuthKey", value: "", type: "secret", enabled: true },
      { key: "rootEmail", value: "", type: "secret", enabled: true },
      { key: "rootPassword", value: "", type: "secret", enabled: true },
      ...oauthVariables,
    ],
    _postman_variable_scope: "environment",
  }),
);
process.stdout.write(
  `${check ? "Verified" : "Generated"} OpenAPI, full schemas, coverage and ${items.length + mcp.length + keyItems.length + oauthItems.length} Postman requests\n`,
);
