import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import { Script } from "node:vm";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { parseDocument } from "yaml";

type Config = {
  server?: string;
  autoDeploy?: boolean;
  container?: {
    port?: number;
    network?: string;
    networkAlias?: string;
  };
  deployment?: { type: string; image?: string; platform?: string };
  domains?: { primary: string };
  tls?: { mode: string };
  health?: {
    type?: string;
    command?: string[];
    publicPath?: string;
    path?: string;
  };
  rollout?: { type: string; maintenanceMode?: boolean };
};
type Entity = Config & {
  id: string;
  type?: string;
  image?: string;
  environments: Record<string, Config>;
  secrets?: { runtime?: string[] };
};
type Root = { buildServer: unknown; environments: Record<string, object> };

const ajv = new Ajv2020({ strict: false });
const addFormats: FormatsPlugin = createRequire(import.meta.url)("ajv-formats");
addFormats(ajv);

async function validate<T>(file: string, schemaName: string): Promise<T> {
  const schema = JSON.parse(
    await readFile(`schemas/towbar/${schemaName}.v2.json`, "utf8"),
  );
  const document = parseDocument(await readFile(file, "utf8"), {
    strict: true,
    uniqueKeys: true,
  });
  assert.equal(document.errors.length, 0, `${file}: invalid YAML`);
  const data: unknown = document.toJS({ maxAliasCount: 0 });
  const check = ajv.getSchema<T>(schema.$id) ?? ajv.compile<T>(schema);
  assert(check(data), `${file}: ${ajv.errorsText(check.errors)}`);
  return data as T;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function merge(
  defaults: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    const existing = result[key];
    result[key] =
      isObject(existing) && isObject(value) ? merge(existing, value) : value;
  }
  return result;
}

function configuration(entity: Entity, environment: string): Config {
  const { environments, secrets: _secrets, ...defaults } = entity;
  const overrides = environments[environment];
  assert(overrides, `${entity.id}: missing ${environment} configuration`);
  return merge(defaults, overrides) as Config;
}

const [root, app, database, web] = await Promise.all([
  validate<Root>("towbar.yml", "repository"),
  validate<Entity>(".towbar/services/vitalog.service.yml", "app"),
  validate<Entity>(
    ".towbar/datastores/vitalog-postgres.datastore.yml",
    "resource",
  ),
  validate<Entity>(".towbar/services/vitalog-web.service.yml", "app"),
]);
assert(Object.keys(root.environments).length > 0);
assert.equal(
  root.buildServer,
  null,
  "Released images do not need a build server",
);
assert.notEqual(app.id, database.id);
assert.equal(database.type, "postgres");
if (database.image)
  assert(
    /@sha256:[0-9a-f]{64}$/.test(database.image),
    "Custom PostgreSQL images need an immutable digest",
  );
for (const entity of [app, database, web]) {
  for (const environment of Object.keys(entity.environments))
    assert(
      environment in root.environments,
      `Unknown environment ${environment}`,
    );
  const keys = entity.secrets?.runtime ?? [];
  assert.equal(
    new Set(keys).size,
    keys.length,
    `${entity.id}: duplicate secrets`,
  );
}
for (const key of [
  "AUTH_KEY",
  "ROOT_EMAIL",
  "ROOT_PASSWORD",
  "DATABASE_URL",
  "ALLOWED_HOSTS",
  "PUBLIC_BASE_URL",
  "UI_BASE_URL",
])
  assert(app.secrets?.runtime?.includes(key), `Missing service key ${key}`);
for (const key of ["POSTGRES_USER", "POSTGRES_DB", "POSTGRES_PASSWORD"])
  assert(
    database.secrets?.runtime?.includes(key),
    `Missing datastore key ${key}`,
  );

for (const environment of Object.keys(root.environments)) {
  const service = configuration(app, environment);
  const datastore = configuration(database, environment);
  assert(service.server && isIP(service.server), "Service needs an IP target");
  assert.equal(
    service.server,
    datastore.server,
    "Workloads need the same server",
  );
  assert(service.container?.network, "Service needs a private network");
  assert.equal(service.container.network, datastore.container?.network);
  assert(datastore.container?.networkAlias, "Datastore needs a DNS alias");
  assert.notEqual(
    service.container.networkAlias,
    datastore.container.networkAlias,
  );
  if (service.container.networkAlias)
    assert.equal(
      service.rollout?.maintenanceMode,
      true,
      "Singleton service aliases require maintenance mode",
    );
  assert(!datastore.domains, "PostgreSQL must stay private");
  if (service.health?.type === "command") {
    assert.equal(service.rollout?.type, "recreate");
    const command = service.health.command;
    assert(command?.length, "Readiness needs a command");
    if (command[0] === "node" && command[1] === "-e") new Script(command[2]!);
    if (service.domains) assert(service.health.publicPath);
  }
  if (service.domains) assert(service.tls, "Public routing requires TLS");
  const ui = configuration(web, environment);
  assert.equal(ui.server, service.server);
  assert.equal(ui.domains?.primary, "vitalog.praveent.com");
  assert.equal(service.domains?.primary, "vitalog-api.praveent.com");
  assert.equal(ui.health?.publicPath ?? ui.health?.path, "/healthz");
  assert(
    !ui.container?.networkAlias,
    "UI does not require a private API alias",
  );
  assert.deepEqual(web.secrets?.runtime, ["API_BASE_URL", "UI_BASE_URL"]);
  const versions: string[] = [];
  let pendingDigest = false;
  const sourceVersion = JSON.parse(
    await readFile("package.json", "utf8"),
  ).version;
  for (const [config, repository] of [
    [service, "vitalog-api"],
    [ui, "vitalog-web"],
  ] as const) {
    const deployment = config.deployment;
    assert(deployment, "An image deployment is required");
    assert.equal(deployment.type, "image");
    assert.equal(deployment.platform, "linux/arm64");
    const image = deployment.image;
    assert(image, "An image reference is required");
    const match = image.match(
      new RegExp(
        `^ghcr\\.io/avgeek-oss/${repository}:(v[0-9]+\\.[0-9]+\\.[0-9]+)(@sha256:[0-9a-f]{64})?$`,
      ),
    );
    assert(
      match,
      "Images need a release version and optional immutable digest",
    );
    assert.equal(
      match[1],
      `v${sourceVersion}`,
      "Image tag must match source version",
    );
    if (!match[2]) {
      assert.equal(
        config.autoDeploy,
        false,
        "Unpinned image candidates must not auto-deploy",
      );
      pendingDigest = true;
    }
    versions.push(match[1]!);
  }
  assert.equal(
    versions[0],
    versions[1],
    "API and web must use the same release",
  );
  process.stdout.write(
    `PASS Towbar ${environment}: ${app.id} + ${web.id} + ${database.id} on ${service.server}${pendingDigest ? " (candidate images; pin published digests before rollout)" : ""}\n`,
  );
}
