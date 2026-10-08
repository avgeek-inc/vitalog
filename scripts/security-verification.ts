import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { application } from "../src/app.js";
import { configuration } from "../src/config.js";
import { database } from "../src/db/client.js";
import { object, type Data } from "../src/domain/types.js";
import { Service } from "../src/service.js";
import { migrateDatabase } from "./migrate.js";

const key = randomBytes(48).toString("base64url");
const password = randomBytes(24).toString("hex");
const container = `vitalog-security-${process.pid}`;
const environment = { ...process.env, POSTGRES_PASSWORD: password };
const checks: string[] = [];
const logs: Data[] = [];
let connection: ReturnType<typeof database> | undefined;
let server: ReturnType<typeof serve> | undefined;
let client: Client | undefined;
let baseUrl = "";
let requestNumber = 0;
const headers = { Authorization: `Bearer ${key}` };
const body = {
  occurred_on: "2026-09-10",
  provenance: { source_type: "manual", value_kind: "reported" },
  data: {
    entry_kind: "intake",
    nutrients: { energy_kcal: 123.45 },
    notes: "Supplied synthetic observation for security verification",
  },
};
const command = (args: string[]) =>
  execFileSync("docker", args, {
    env: environment,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
const escaped = (text: string) =>
  text.replaceAll(
    key,
    [...key]
      .map(
        (character) =>
          `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
      )
      .join(""),
  );
const post = (
  path: string,
  text: string,
  extraHeaders: Record<string, string> = {},
) =>
  fetch(baseUrl + path, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      "Idempotency-Key": `security-request-${++requestNumber}`,
      ...extraHeaders,
    },
    body: text,
  });
async function rejected(name: string, response: Response) {
  assert.equal(response.status, 422, name);
  const text = await response.text();
  assert(
    !text.includes(key),
    "Rejected response contains a configured credential",
  );
  assert.equal(object(JSON.parse(text)).code, "VALIDATION_ERROR", name);
  checks.push(name);
}
async function verify() {
  command([
    "run",
    "--detach",
    "--rm",
    "--name",
    container,
    "-e",
    "POSTGRES_PASSWORD",
    "-e",
    "POSTGRES_USER=vitalog",
    "-e",
    "POSTGRES_DB=vitalog",
    "-p",
    "127.0.0.1::5432",
    "postgres:17.11-bookworm",
  ]);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      command([
        "exec",
        container,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "vitalog",
        "-d",
        "vitalog",
      ]);
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  assert(ready, "Disposable security database did not become ready");
  const port = command(["port", container, "5432/tcp"]).split(":").at(-1)!;
  const url = `postgresql://vitalog:${password}@127.0.0.1:${port}/vitalog`;
  await migrateDatabase(url);
  connection = database(url);
  const config = configuration({ AUTH_KEY: key, DATABASE_URL: url });
  const service = new Service(connection.db, config.authDigest.toString("hex"));
  const app = application(service, config, (entry) => logs.push(entry));
  const apiPort = await new Promise<number>((resolve) => {
    server = serve(
      { fetch: app.fetch, port: 0, hostname: "127.0.0.1" },
      (info) => resolve(info.port),
    );
  });
  baseUrl = `http://127.0.0.1:${apiPort}`;
  config.allowedHosts.push(new URL(baseUrl).host);
  const control = await post("/v1/nutrition", JSON.stringify(body));
  assert.equal(control.status, 200, "Ordinary REST write must remain usable");
  const stored = object(object(await control.json()).record);
  assert.equal(object(stored.data).notes, body.data.notes);
  checks.push("Ordinary REST write preserves the supplied data");
  for (const field of ["source_description", "source_locator", "assumptions"]) {
    const input = {
      ...body,
      provenance: {
        ...body.provenance,
        [field]:
          field === "assumptions"
            ? [`before ${key} after`]
            : `before ${key} after`,
      },
    };
    for (const encode of [false, true]) {
      const text = JSON.stringify(input);
      await rejected(
        `REST ${field}, ${encode ? "JSON escaped" : "literal"}`,
        await post("/v1/nutrition", encode ? escaped(text) : text),
      );
    }
  }
  for (const encode of [false, true]) {
    const text = JSON.stringify({
      ...body,
      data: { ...body.data, notes: `before ${key} after` },
    });
    await rejected(
      `REST notes, ${encode ? "JSON escaped" : "literal"}`,
      await post("/v1/nutrition", encode ? escaped(text) : text),
    );
    const property = JSON.stringify({ ...body, [key]: "unknown property" });
    await rejected(
      `Unknown REST property, ${encode ? "JSON escaped" : "literal"}`,
      await post("/v1/nutrition", encode ? escaped(property) : property),
    );
  }
  await rejected(
    "Configured credential in Idempotency-Key",
    await post("/v1/nutrition", JSON.stringify(body), {
      "Idempotency-Key": key,
    }),
  );
  await rejected(
    "Correction reason",
    await post(
      `/v1/records/${stored.id}/corrections`,
      JSON.stringify({
        expected_version: 1,
        reason: `before ${key} after`,
        replacement: { record_type: "nutrition", ...body },
      }),
    ),
  );
  await rejected(
    "Void reason",
    await post(
      `/v1/records/${stored.id}/voids`,
      JSON.stringify({ expected_version: 1, reason: key }),
    ),
  );
  for (const [target, query] of [
    ["name", new URLSearchParams({ [key]: "unknown" })],
    ["value", new URLSearchParams({ query: `before ${key} after` })],
  ] as const) {
    await rejected(
      `Decoded query ${target} credential`,
      await fetch(baseUrl + "/v1/catalog?" + query, { headers }),
    );
  }
  for (const encode of [false, true]) {
    const value = encode
      ? [...key]
          .map((character) => `%${character.charCodeAt(0).toString(16)}`)
          .join("")
      : key;
    await rejected(
      `URL path credential, ${encode ? "percent encoded" : "literal"}`,
      await fetch(baseUrl + `/v1/records/${value}`, { headers }),
    );
  }
  await rejected(
    "Prototype-named query remains an unknown field",
    await fetch(baseUrl + "/v1/catalog?__proto__=unknown", { headers }),
  );
  const prototype = JSON.parse(JSON.stringify(body));
  Object.defineProperty(prototype, "__proto__", {
    value: { hidden: "unknown" },
    enumerable: true,
  });
  await rejected(
    "Prototype-named JSON remains an unknown field",
    await post("/v1/nutrition", JSON.stringify(prototype)),
  );
  for (const header of ["MCP-Protocol-Version", "Mcp-Session-Id", "Cookie"]) {
    await rejected(
      `Configured credential in ${header}`,
      await post("/mcp", "{}", { [header]: key }),
    );
  }
  client = new Client({
    name: "vitalog-security-verification",
    version: "1.0.0",
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(baseUrl + "/mcp"), {
      requestInit: { headers },
    }),
  );
  const read = await client.callTool({
    name: "health_get_record",
    arguments: { id: stored.id },
  });
  assert(!read.isError, "Authenticated MCP retrieval must remain usable");
  assert.equal(object(object(read.structuredContent).record).id, stored.id);
  checks.push(
    "Fresh authenticated official MCP client retrieves the committed REST record",
  );
  let failed = false;
  try {
    await client.callTool({
      name: "health_log_nutrition",
      arguments: {
        idempotency_key: "security-mcp",
        ...body,
        provenance: {
          ...body.provenance,
          source_description: `before ${key} after`,
        },
      },
    });
  } catch (error) {
    failed = true;
    assert(
      !String(error).includes(key),
      "MCP client failure contains a configured credential",
    );
  }
  assert(failed, "MCP must reject credentials before mutation");
  checks.push("Official MCP client rejects a credential without reflecting it");
  for (const encode of [false, true]) {
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "health_log_nutrition",
        arguments: {
          idempotency_key: "security-mcp-raw",
          ...body,
          data: { ...body.data, notes: `before ${key} after` },
        },
      },
    });
    await rejected(
      `MCP admitted note, ${encode ? "JSON escaped" : "literal"}`,
      await post("/mcp", encode ? escaped(request) : request, {
        Accept: "application/json, text/event-stream",
      }),
    );
  }
  await rejected(
    "MCP method cannot reflect configured credentials",
    await post("/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method: key }), {
      Accept: "application/json, text/event-stream",
    }),
  );
  await rejected(
    "Malformed MCP JSON with escaped credential property",
    await post("/mcp", escaped(`{"${key}": "value",`), {
      Accept: "application/json, text/event-stream",
    }),
  );
  const result = await connection.pool.query(
    "SELECT (SELECT count(*)::int FROM health_records) records, (SELECT count(*)::int FROM record_revisions) revisions, (SELECT count(*)::int FROM idempotency_requests) idempotency, EXISTS(SELECT FROM health_records r WHERE position($1 in row_to_json(r)::text)>0) record_credential, EXISTS(SELECT FROM record_revisions r WHERE position($1 in row_to_json(r)::text)>0) revision_credential, EXISTS(SELECT FROM idempotency_requests r WHERE position($1 in row_to_json(r)::text)>0) idempotency_credential",
    [key],
  );
  assert.deepEqual(result.rows[0], {
    records: 1,
    revisions: 1,
    idempotency: 1,
    record_credential: false,
    revision_credential: false,
    idempotency_credential: false,
  });
  checks.push(
    "Rejected credentials create no records, revisions or retry metadata",
  );
  assert(
    !JSON.stringify(logs).includes(key),
    "Operational logs contain a configured credential",
  );
  checks.push("Operational logs contain no configured credential");
  const [originalRecord, originalRevision] = await Promise.all([
    connection.pool.query(
      "SELECT payload, schema_version FROM health_records WHERE id=$1",
      [stored.id],
    ),
    connection.pool.query(
      "SELECT snapshot FROM record_revisions WHERE record_id=$1 AND version=1",
      [stored.id],
    ),
  ]);
  await connection.pool.query(
    "UPDATE health_records SET schema_version=1, payload=jsonb_set(payload,'{notes}',to_jsonb($1::text)) WHERE id=$2",
    [key, stored.id],
  );
  await connection.pool.query(
    "UPDATE record_revisions SET snapshot=jsonb_set(jsonb_set(snapshot,'{schema_version}','1'::jsonb),'{data,notes}',to_jsonb($1::text)) WHERE record_id=$2 AND version=1",
    [key, stored.id],
  );
  for (const transport of ["REST", "MCP"]) {
    const response =
      transport === "REST"
        ? await fetch(
            baseUrl + `/v1/records/${stored.id}?include_history=true`,
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
                arguments: { id: stored.id, include_history: true },
              },
            }),
            { Accept: "application/json, text/event-stream" },
          );
    assert.equal(
      response.status,
      500,
      "Restored credential-bearing record must not be returned",
    );
    const text = await response.text();
    assert(
      !text.includes(key),
      "Restored credential was reflected in a response",
    );
    assert.equal(object(JSON.parse(text)).code, "INTERNAL_ERROR");
    checks.push(
      `${transport} blocks restored legacy credentials in records/history`,
    );
  }
  const legacy = await connection.pool.query(
    "SELECT payload->>'notes' AS notes FROM health_records WHERE id=$1",
    [stored.id],
  );
  assert(
    legacy.rows[0].notes === key,
    "Response guard must not rewrite a stored observation",
  );
  checks.push("Response guarding leaves the restored observation unchanged");
  await connection.pool.query(
    "UPDATE health_records SET schema_version=$1,payload=$2 WHERE id=$3",
    [
      originalRecord.rows[0].schema_version,
      originalRecord.rows[0].payload,
      stored.id,
    ],
  );
  await connection.pool.query(
    "UPDATE record_revisions SET snapshot=$1 WHERE record_id=$2 AND version=1",
    [originalRevision.rows[0].snapshot, stored.id],
  );
  const report = {
    tested_at: new Date().toISOString(),
    postgres: (await connection.pool.query("SHOW server_version")).rows[0]
      .server_version,
    mcp_sdk: "@modelcontextprotocol/sdk@1.31.0",
    mcp_protocol_revision: LATEST_PROTOCOL_VERSION,
    checks,
    status: "passed",
    data_scope:
      "Synthetic fixtures and generated credentials in an isolated disposable PostgreSQL container",
  };
  await mkdir(".test-artifacts", { recursive: true });
  await writeFile(
    ".test-artifacts/security.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  process.stdout.write(
    `PASS ${checks.length} credential/storage/transport security checks\n`,
  );
}
try {
  await verify();
} catch {
  process.stderr.write(
    JSON.stringify({
      event: "security_verification_failed",
      completed_checks: checks.length,
      last_completed_check: checks.at(-1) ?? "Disposable database startup",
    }) + "\n",
  );
  process.exitCode = 1;
} finally {
  await client?.close();
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  await connection?.pool.end();
  try {
    command(["rm", "--force", container]);
  } catch {
    /* An automatically removed disposable container requires no cleanup. */
  }
}
