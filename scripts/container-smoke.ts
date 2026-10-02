import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { parse, stringify } from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { object } from "../src/domain/types.js";

const towbar = process.argv.includes("--towbar");
type RuntimeManifest = {
  image?: string;
  container: {
    networkAlias: string;
    command?: string[];
    resources: { cpus: number; memory: string };
  };
  domains?: { primary: string };
  health?: { command: string[] };
};
let service: RuntimeManifest | undefined;
let datastore: RuntimeManifest | undefined;
let override: string | undefined;
if (towbar) {
  await import("./validate-towbar.js");
  service = parse(
    await readFile(".towbar/services/vitalog.service.yml", "utf8"),
  ) as RuntimeManifest;
  datastore = parse(
    await readFile(".towbar/datastores/vitalog-postgres.datastore.yml", "utf8"),
  ) as RuntimeManifest;
  await mkdir(".test-artifacts", { recursive: true });
  override = resolve(`.test-artifacts/towbar-compose-${process.pid}.yaml`);
  await writeFile(
    override,
    stringify({
      services: {
        api: {
          build: { context: resolve(".") },
          mem_limit: service.container.resources.memory,
          cpus: service.container.resources.cpus,
          networks: { default: { aliases: [service.container.networkAlias] } },
          environment: {
            DATABASE_URL: `postgresql://vitalog:\${POSTGRES_PASSWORD}@${datastore.container.networkAlias}:5432/vitalog`,
          },
          healthcheck: {
            test: ["CMD", ...service.health!.command],
            interval: "5s",
            timeout: "6s",
            retries: 10,
            start_period: "10s",
          },
        },
        postgres: {
          image: datastore.image,
          mem_limit: datastore.container.resources.memory,
          cpus: datastore.container.resources.cpus,
          command: datastore.container.command,
          networks: {
            default: { aliases: [datastore.container.networkAlias] },
          },
        },
      },
    }),
  );
}
const project = `vitalog-${towbar ? "towbar" : "smoke"}-${process.pid}`;
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
  ROOT_EMAIL: "root@example.test",
  ROOT_PASSWORD: randomBytes(32).toString("base64url"),
  POSTGRES_PASSWORD: randomBytes(32).toString("hex"),
  PORT: String(publishedPort),
  ALLOWED_HOSTS: [service?.domains?.primary, `127.0.0.1:${publishedPort}`]
    .filter(Boolean)
    .join(","),
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
    ...(override ? ["--file", override] : []),
    ...args,
  ]);
let client: Client | undefined;
try {
  compose(["up", "--detach", "--build", "--wait", "--wait-timeout", "90"]);
  const port = compose(["port", "api", "3000"]).split(":").at(-1)!;
  const url = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Bearer ${key}` };
  const page = await fetch(url + "/api-keys");
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  await page.text();
  const issued = await fetch(url + "/auth/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: url },
    body: JSON.stringify({
      email: env.ROOT_EMAIL,
      password: env.ROOT_PASSWORD,
      name: "Container smoke",
    }),
  });
  assert.equal(issued.status, 201);
  const issuedKey = object(await issued.json());
  const generatedHeaders = { Authorization: `Bearer ${issuedKey.api_key}` };
  const generatedCatalog = await fetch(url + "/v1/catalog", {
    headers: generatedHeaders,
  });
  assert.equal(generatedCatalog.status, 200);
  await generatedCatalog.text();
  const administration = await fetch(url + "/v1/api-keys", {
    headers: generatedHeaders,
  });
  assert.equal(administration.status, 403);
  await administration.text();
  const revoked = await fetch(url + `/v1/api-keys/${issuedKey.id}`, {
    method: "DELETE",
    headers,
  });
  assert.equal(revoked.status, 200);
  await revoked.text();
  const denied = await fetch(url + "/v1/catalog", {
    headers: generatedHeaders,
  });
  assert.equal(denied.status, 401);
  await denied.text();
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
  const profileChecks: string[] = [];
  if (service && datastore) {
    for (const [name, manifest] of [
      ["api", service],
      ["postgres", datastore],
    ] as const) {
      const settings = JSON.parse(
        docker([
          "inspect",
          "--format",
          "{{json .HostConfig}}",
          compose(["ps", "--quiet", name]),
        ]),
      );
      const match = /^(\d+)([mg])$/.exec(manifest.container.resources.memory);
      assert(match);
      assert.equal(
        settings.Memory,
        Number(match[1]) * (match[2] === "g" ? 1024 ** 3 : 1024 ** 2),
      );
      assert.equal(
        settings.NanoCpus,
        manifest.container.resources.cpus * 1_000_000_000,
      );
    }
    assert.equal(
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
        "show shared_buffers",
      ]),
      "64MB",
    );
    assert.equal(
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
        "show max_connections",
      ]),
      "30",
    );
    compose(["exec", "--no-TTY", "api", ...service.health!.command]);
    profileChecks.push(
      "manifest runtime CPU/memory limits",
      "tuned PostgreSQL settings",
      "authenticated readiness uses the configured public Host header",
      "private PostgreSQL network alias",
    );
  }
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
  if (service) {
    compose(["stop", "postgres"]);
    assert.throws(
      () => compose(["exec", "--no-TTY", "api", ...service.health!.command]),
      (error: unknown) => object(error).status === 1,
    );
    compose(["start", "postgres"]);
    compose(["up", "--detach", "--wait", "--wait-timeout", "90"]);
    compose(["exec", "--no-TTY", "api", ...service.health!.command]);
    assert.equal(count(), "1");
    profileChecks.push(
      "readiness fails while PostgreSQL is unavailable",
      "readiness recovers after PostgreSQL restarts without data loss",
    );
  }
  const report = {
    tested_at: new Date().toISOString(),
    mode: towbar
      ? "local_compose_with_towbar_manifest_runtime_settings"
      : "docker_compose",
    image: env.VITALOG_IMAGE,
    postgres_image: datastore?.image ?? "postgres:17.11-bookworm",
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
      ...profileChecks,
    ],
    status: "passed",
  };
  await mkdir(".test-artifacts", { recursive: true });
  await writeFile(
    towbar ? ".test-artifacts/towbar.json" : ".test-artifacts/container.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  process.stdout.write(
    `PASS ${report.checks.length} ${towbar ? "Towbar profile" : "Compose/container"} checks\n`,
  );
} finally {
  await client?.close();
  compose(["down", "--volumes", "--remove-orphans"]);
  if (override) await rm(override, { force: true });
}
