import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { object } from "../src/domain/types.js";

const project = `vitalog-smoke-${process.pid}`;
const key = randomBytes(32).toString("base64url");
const reservation = createServer();
await new Promise<void>((resolve, reject) => {
  reservation.on("error", reject);
  reservation.listen(0, "127.0.0.1", resolve);
});
const address = reservation.address();
assert(address && typeof address === "object");
const publishedPort = address.port;
await new Promise<void>((resolve, reject) =>
  reservation.close((error) => (error ? reject(error) : resolve())),
);
const env = {
  ...process.env,
  AUTH_KEY: key,
  POSTGRES_PASSWORD: randomBytes(32).toString("hex"),
  PORT: String(publishedPort),
  ALLOWED_HOSTS: `127.0.0.1:${publishedPort}`,
  ALLOWED_ORIGINS: "",
  TRUST_PROXY: "false",
  VITALOG_IMAGE: `${project}:local`,
};
const docker = (args: string[]) =>
  execFileSync("docker", args, {
    env,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
const compose = (args: string[]) =>
  docker([
    "compose",
    "--project-name",
    project,
    "--file",
    "compose.yaml",
    ...args,
  ]);
let client: Client | undefined;
try {
  compose(["up", "--detach", "--build", "--wait", "--wait-timeout", "90"]);
  const port = compose(["port", "api", "3000"]).split(":").at(-1)!;
  const url = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Bearer ${key}` };
  const count = () =>
    compose([
      "exec",
      "--no-TTY",
      "postgres",
      "psql",
      "-U",
      "vitalog",
      "-d",
      "vitalog",
      "-Atc",
      "select count(*) from health_records",
    ]);
  assert.equal(count(), "0");
  assert.equal(compose(["exec", "--no-TTY", "api", "id", "-u"]), "1000");
  const containerId = compose(["ps", "--quiet", "api"]);
  assert.equal(
    docker([
      "inspect",
      "--format",
      "{{.HostConfig.ReadonlyRootfs}}",
      containerId,
    ]),
    "true",
  );
  assert.equal((await fetch(url + "/readyz", { headers })).status, 200);
  assert.equal((await fetch(url + "/v1/catalog")).status, 401);
  const body = {
    occurred_on: "2026-09-10",
    provenance: { source_type: "manual", value_kind: "reported" },
    data: { entry_kind: "intake", nutrients: { energy_kcal: 100 } },
  };
  const saved = await fetch(url + "/v1/nutrition", {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      "Idempotency-Key": "container-smoke",
    },
    body: JSON.stringify(body),
  });
  assert.equal(saved.status, 200);
  const record = object(object(await saved.json()).record);
  assert.equal(saved.headers.get("cache-control"), "no-store");
  compose(["restart", "api"]);
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const r = await fetch(url + "/readyz", { headers });
      await r.text();
      if (r.status === 200) {
        ready = true;
        break;
      }
    } catch {
      /* The container is restarting. */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert(ready);
  client = new Client({ name: "vitalog-container-smoke", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url + "/mcp"), {
      requestInit: { headers },
    }),
  );
  const read = await client.callTool({
    name: "health_get_record",
    arguments: { id: record.id },
  });
  assert(!read.isError);
  assert.equal(object(object(read.structuredContent).record).id, record.id);
  const replay = await client.callTool({
    name: "health_log_nutrition",
    arguments: { idempotency_key: "container-smoke", ...body },
  });
  assert(!replay.isError);
  assert.equal(object(replay.structuredContent).idempotent_replay, true);
  assert.equal(count(), "1");
  const logs = compose(["logs", "--no-color", "api"]);
  assert(!logs.includes(key));
  assert(!logs.includes("energy_kcal"));
  const report = {
    tested_at: new Date().toISOString(),
    image: env.VITALOG_IMAGE,
    postgres_image: "postgres:17.11-bookworm",
    checks: [
      "fresh Compose service/database startup and automatic migrations",
      "empty database",
      "non-root UID 1000",
      "read-only root filesystem",
      "readiness",
      "unauthenticated rejection",
      "no-store responses",
      "committed REST write",
      "container restart",
      "fresh MCP client retrieval",
      "cross-interface durable retry",
      "operational log privacy",
    ],
    status: "passed",
  };
  await mkdir(".test-artifacts", { recursive: true });
  await writeFile(
    ".test-artifacts/container.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  process.stdout.write(
    `PASS ${report.checks.length} Compose/container checks\n`,
  );
} finally {
  await client?.close();
  compose(["down", "--volumes", "--remove-orphans"]);
}
