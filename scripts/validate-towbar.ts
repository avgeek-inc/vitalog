import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { Script } from "node:vm";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { parseDocument } from "yaml";

type Config = {
  server?: string;
  container?: {
    port?: number;
    network?: string;
    networkAlias?: string;
  };
  deployment?: { type: string; context: string; dockerfile?: string };
  domains?: { primary: string };
  tls?: { mode: string };
  health?: { type?: string; command?: string[]; publicPath?: string };
  rollout?: { type: string; maintenanceMode?: boolean };
};
type Entity = Config & {
  id: string;
  type?: string;
  image?: string;
  environments: Record<string, Config>;
  secrets?: { runtime?: string[] };
};
type Root = { environments: Record<string, object> };

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
  const check = ajv.compile<T>(schema);
  assert(check(data), `${file}: ${ajv.errorsText(check.errors)}`);
  return data;
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

const [root, app, database] = await Promise.all([
  validate<Root>("towbar.yml", "repository"),
  validate<Entity>(".towbar/services/vitalog.service.yml", "app"),
  validate<Entity>(
    ".towbar/datastores/vitalog-postgres.datastore.yml",
    "resource",
  ),
]);
assert(Object.keys(root.environments).length > 0);
assert.notEqual(app.id, database.id);
assert.equal(database.type, "postgres");
if (database.image)
  assert(
    /@sha256:[0-9a-f]{64}$/.test(database.image),
    "Custom PostgreSQL images need an immutable digest",
  );
for (const entity of [app, database]) {
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
for (const key of ["AUTH_KEY", "DATABASE_URL", "ALLOWED_HOSTS"])
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
  assert.equal(service.deployment?.type, "dockerfile");
  const dockerfile = resolve(
    service.deployment.context,
    service.deployment.dockerfile!,
  );
  assert(dockerfile.startsWith(resolve(".") + "/"));
  assert((await stat(dockerfile)).isFile(), "Dockerfile does not exist");
  if (service.health?.type === "command") {
    assert.equal(service.rollout?.type, "recreate");
    const command = service.health.command;
    assert(command?.length, "Readiness needs a command");
    if (command[0] === "node" && command[1] === "-e") new Script(command[2]!);
    if (service.domains) assert(service.health.publicPath);
  }
  if (service.domains) assert(service.tls, "Public routing requires TLS");
  process.stdout.write(
    `PASS Towbar ${environment}: ${app.id} + ${database.id} on ${service.server}\n`,
  );
}
