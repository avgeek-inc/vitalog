import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { get } from "node:http";
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
let web: RuntimeManifest | undefined;
let override: string | undefined;
if (towbar) {
  await import("./validate-towbar.js");
  service = parse(
    await readFile(".towbar/services/vitalog.service.yml", "utf8"),
  ) as RuntimeManifest;
  datastore = parse(
    await readFile(".towbar/datastores/vitalog-postgres.datastore.yml", "utf8"),
  ) as RuntimeManifest;
  web = parse(
    await readFile(".towbar/services/vitalog-web.service.yml", "utf8"),
  ) as RuntimeManifest;
  await mkdir(".test-artifacts", { recursive: true });
  override = resolve(`.test-artifacts/towbar-compose-${process.pid}.yaml`);
  await writeFile(
    override,
    stringify({
      services: {
        web: {
          mem_limit: web.container.resources.memory,
          cpus: web.container.resources.cpus,
        },
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
const uiReservation = createServer();
await new Promise<void>((resolve) =>
  uiReservation.listen(0, "127.0.0.1", resolve),
);
const uiAddress = uiReservation.address();
assert(uiAddress && typeof uiAddress === "object");
const uiPort = uiAddress.port;
await new Promise<void>((resolve, reject) =>
  uiReservation.close((error) => (error ? reject(error) : resolve())),
);
const uiUrl = `http://127.0.0.1:${uiPort}`;
const env = {
  ...process.env,
  AUTH_KEY: key,
  ROOT_EMAIL: "root@example.test",
  ROOT_PASSWORD: randomBytes(32).toString("base64url"),
  POSTGRES_PASSWORD: randomBytes(32).toString("hex"),
  PORT: String(publishedPort),
  UI_PORT: String(uiPort),
  UI_BASE_URL: uiUrl,
  API_BASE_URL: `http://127.0.0.1:${publishedPort}`,
  PUBLIC_BASE_URL: `http://127.0.0.1:${publishedPort}`,
  VITALOG_WEB_IMAGE: `${project}-web:local`,
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
  const oldPage = await fetch(url + "/api-keys", { redirect: "manual" });
  assert.equal(oldPage.status, 302);
  assert.equal(oldPage.headers.get("location"), uiUrl + "/api-keys");
  for (const route of ["/api-keys", "/oauth/authorize"]) {
    const page = await fetch(uiUrl + route);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("cache-control")!, /no-store/);
    const csp = page.headers.get("content-security-policy")!;
    assert.match(csp, /script-src 'self' 'nonce-/);
    assert.match(csp, /form-action 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert(csp.includes(env.API_BASE_URL));
    const nonce = /'nonce-([^']+)'/.exec(csp)![1];
    const html = await page.text();
    assert(html.includes("/brand/vitalog-mark.png"));
    assert(html.includes(env.API_BASE_URL));
    for (const secret of [
      key,
      env.ROOT_PASSWORD,
      env.ROOT_EMAIL,
      env.POSTGRES_PASSWORD,
    ])
      assert(!html.includes(secret));
    for (const script of html.matchAll(/<script([^>]*)>/g))
      assert(
        script[1]!.includes(`nonce="${nonce}"`),
        "Every script requires the request nonce",
      );
    const assets = [
      ...new Set(
        [...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"\s]+)"/g)].map(
          (match) => match[1]!,
        ),
      ),
    ];
    assert(assets.some((path) => path.endsWith(".js")));
    assert(assets.some((path) => path.endsWith(".css")));
    for (const path of assets) {
      const asset = await fetch(uiUrl + path);
      assert.equal(asset.status, 200);
      const content = await asset.text();
      for (const secret of [
        key,
        env.ROOT_PASSWORD,
        env.ROOT_EMAIL,
        env.POSTGRES_PASSWORD,
      ])
        assert(!content.includes(secret));
    }
  }
  const logo = await fetch(uiUrl + "/brand/vitalog-mark.png");
  assert.equal(logo.status, 200);
  assert.equal(
    Buffer.from(await logo.arrayBuffer())
      .subarray(0, 8)
      .toString("hex"),
    "89504e470d0a1a0a",
  );
  assert.equal((await fetch(uiUrl + "/v1/catalog")).status, 404);
  const untrustedHost = await new Promise<number | undefined>(
    (resolve, reject) => {
      get(
        uiUrl + "/api-keys",
        { headers: { Host: "untrusted.example" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      ).on("error", reject);
    },
  );
  assert.equal(untrustedHost, 403);
  assert.equal(compose(["exec", "--no-TTY", "web", "id", "-u"]), "1000");
  const uiSettings = JSON.parse(
    docker([
      "inspect",
      "--format",
      "{{json .Config.Env}}",
      compose(["ps", "--quiet", "web"]),
    ]),
  ) as string[];
  for (const name of [
    "AUTH_KEY",
    "ROOT_EMAIL",
    "ROOT_PASSWORD",
    "DATABASE_URL",
  ])
    assert(!uiSettings.some((value) => value.startsWith(name + "=")));
  assert.equal(
    docker([
      "inspect",
      "--format",
      "{{.HostConfig.ReadonlyRootfs}}",
      compose(["ps", "--quiet", "web"]),
    ]),
    "true",
  );
  const preflight = await fetch(url + "/auth/api-keys", {
    method: "OPTIONS",
    headers: {
      Origin: uiUrl,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), uiUrl);
  const issued = await fetch(url + "/auth/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: uiUrl },
    body: JSON.stringify({
      email: env.ROOT_EMAIL,
      password: env.ROOT_PASSWORD,
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
  const login = await fetch(uiUrl + "/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: uiUrl },
    body: JSON.stringify({
      email: env.ROOT_EMAIL,
      password: env.ROOT_PASSWORD,
    }),
  });
  assert.equal(login.status, 200);
  assert.deepEqual(await login.json(), { signed_in: true });
  const cookie = login.headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly/i);
  const sessionCookie = cookie.split(";")[0]!;
  for (const [path, heading] of [
    ["/daily", "Daily nutrition"],
    ["/weight", "Current weight"],
  ] as const) {
    const page = await fetch(uiUrl + path, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert(
      html.includes(heading),
      "The dashboard must read its API inside Docker",
    );
    assert(!html.includes(sessionCookie.split("=")[1]!));
    assert(!html.includes("api:3000"));
  }
  const logout = await fetch(uiUrl + "/auth/logout", {
    method: "POST",
    headers: { Cookie: sessionCookie, Origin: uiUrl },
  });
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), { signed_out: true, revoked: true });
  assert.equal(
    (
      await fetch(url + "/v1/goals", {
        headers: { Authorization: `Bearer ${sessionCookie.split("=")[1]!}` },
      })
    ).status,
    401,
  );
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
      ["web", web!],
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
      "fresh Compose API/UI/database startup and automatic migrations",
      "separate Next.js authentication routes, nonce CSP and trusted browser origin",
      "UI container non-root, read-only and contains no API credentials",
      "UI compiled assets and logo with no configured secrets",
      "dashboard sign-in, server reads through the private API and server revocation",
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
