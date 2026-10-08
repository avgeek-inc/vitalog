import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, posix } from "node:path";
import { format } from "prettier";
import { openapi } from "../src/openapi.js";
import { operations } from "../src/registry/operations.js";
import { examples } from "../tests/fixtures.js";

const check = process.argv.includes("--check");
async function save(path: string, contents: string | Buffer) {
  if (check) {
    const actual = await readFile(path);
    if (!actual.equals(Buffer.from(contents)))
      throw new Error(
        `Mintlify artifact is stale: ${path}. Run npm run docs:generate.`,
      );
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
}
const pages = [
  [
    "attachments",
    "attachments",
    "Reusable attachments",
    "Upload private images and PDFs once and reuse them across health records.",
  ],
  [
    "web",
    "dashboard",
    "Daily View and Weight Management",
    "View daily nutrition, mood, water, exercise and weight history.",
  ],
  [
    "api-keys",
    "api-keys",
    "API keys",
    "Create a personal API key with explicit permissions and expiry, and manage keys and MCP connections.",
  ],
  [
    "oauth",
    "oauth",
    "MCP OAuth",
    "Discovery, client identity, consent and authorization-code exchange.",
  ],
  [
    "integration",
    "records",
    "Record contracts",
    "Log observations, discover schemas, read summaries and correct records.",
  ],
  [
    "goals",
    "goals",
    "Goals and progress",
    "Weight baselines, nutrition limits, water and exercise targets.",
  ],
  [
    "towbar-deployment",
    "towbar",
    "Deploy with Towbar",
    "Run PostgreSQL, the API and the web app on your own server.",
  ],
] as const;
const routes = new Map(pages.map(([file, route]) => [`${file}.md`, route]));
for (const [file, route, title, description] of pages) {
  let body = (await readFile(`docs/${file}.md`, "utf8")).replace(
    /^# .+\n\n/,
    "",
  );
  body = body.replace(
    /\]\(([^)\s#]+)(#[^)]+)?\)/g,
    (match, target: string, anchor = "") => {
      if (/^(https?:|mailto:|#)/.test(target)) return match;
      const normalized = target.replace(/^\.\//, "").replace(/^docs\//, "");
      const siteRoute = routes.get(normalized);
      return siteRoute
        ? `](/${siteRoute}${anchor})`
        : `](https://github.com/avgeek-oss/vitalog/blob/main/${posix.normalize(target.startsWith("docs/") || target.startsWith("apps/") || target.startsWith("scripts/") ? target : `docs/${normalized}`)}${anchor})`;
    },
  );
  await save(
    `docs/${route}.mdx`,
    await format(
      `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}`,
      { parser: "mdx" },
    ),
  );
}
for (const asset of ["vitalog-mark.png", "vitalog-favicon.png"]) {
  await save(
    `docs/assets/${asset}`,
    await readFile(`apps/web/public/brand/${asset}`),
  );
}
// Hoist schema-local definitions to standard OpenAPI components for Mintlify.
const definitions: Record<string, unknown> = {};
function documentReferences(
  value: unknown,
  path: string[] = [],
  references: Record<string, string> = {},
): unknown {
  if (Array.isArray(value))
    return value.map((item, index) =>
      documentReferences(item, [...path, String(index)], references),
    );
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  const localDefinitions = object.$defs as Record<string, unknown> | undefined;
  let localReferences = references;
  if (localDefinitions) {
    const prefix = createHash("sha256")
      .update(JSON.stringify(path))
      .digest("hex")
      .slice(0, 12);
    localReferences = Object.fromEntries(
      Object.keys(localDefinitions).map((key) => [
        key,
        `Schema_${prefix}_${key}`,
      ]),
    );
    for (const [key, definition] of Object.entries(localDefinitions))
      definitions[localReferences[key]!] = documentReferences(
        definition,
        [...path, "$defs", key],
        localReferences,
      );
  }
  return Object.fromEntries(
    Object.entries(object)
      .filter(([key]) => key !== "$id" && key !== "$defs")
      .map(([key, item]) => {
        if (
          key === "$ref" &&
          typeof item === "string" &&
          item.startsWith("#/$defs/")
        ) {
          const [name, ...suffix] = item.slice("#/$defs/".length).split("/");
          const target = localReferences[name!];
          if (!target)
            throw new Error(
              `Unresolved schema reference at ${path.join("/")}: ${item}`,
            );
          return [
            key,
            `#/components/schemas/${target}${suffix.length ? "/" + suffix.join("/") : ""}`,
          ];
        }
        return [key, documentReferences(item, [...path, key], localReferences)];
      }),
  );
}
const apiDocument = openapi();
for (const [path, methods] of Object.entries(
  apiDocument.paths as Record<string, Record<string, Record<string, unknown>>>,
)) {
  for (const [method, operation] of Object.entries(methods)) {
    const id = String(
      operation.operationId ?? `${method}_${path.replace(/[^a-z0-9]+/gi, "_")}`,
    );
    operation.description = operation.description ?? operation.summary;
    const title = id.replace(/^health_/, "").replaceAll("_", " ");
    operation.summary = operation.operationId
      ? (title[0]!.toUpperCase() + title.slice(1))
          .replace(/\bapi\b/g, "API")
          .replace(/\bOauth\b/g, "OAuth")
          .replace(/\bcheckin\b/g, "check-in")
      : operation.summary;
    operation.operationId = id;
    if (path.startsWith("/v1/goals") || path.endsWith("/goal-progress"))
      operation.tags = ["Goals"];
    else if (path.startsWith("/v1/attachments"))
      operation.tags = ["Attachments"];
    else if (path === "/v1/catalog") operation.tags = ["Catalog"];
    else if (id.startsWith("health_")) operation.tags = ["Health records"];
    else if (!operation.tags) operation.tags = ["Service"];
    const domainOperation = operations.find((item) => item.name === id);
    const content = (
      operation.requestBody as
        | { content?: { "application/json"?: Record<string, unknown> } }
        | undefined
    )?.content?.["application/json"];
    if (content && domainOperation?.record_type) {
      const input = examples[domainOperation.record_type];
      content.example = domainOperation.batch ? { records: [input] } : input;
    }
    if (content && id === "health_set_goal")
      content.example = {
        metric: "hydration:water_ml",
        target: 2500,
        expected_version: 0,
      };
  }
}
const mintlifyDocument = documentReferences(apiDocument) as ReturnType<
  typeof openapi
>;
const components = mintlifyDocument.components as Record<string, unknown>;
components.schemas = {
  ...(components.schemas as Record<string, unknown>),
  ...definitions,
};
await save(
  "docs/openapi.json",
  JSON.stringify(mintlifyDocument, null, 2) + "\n",
);
const toolTable = operations
  .map(
    (operation) =>
      `| \`${operation.name}\` | ${operation.description.replaceAll("|", "\\|")} |`,
  )
  .join("\n");
await save(
  "docs/mcp-tools.mdx",
  await format(
    `---\ntitle: "MCP tools"\ndescription: "Tools generated from the same registry as the REST API."\n---\n\nVitalog exposes ${operations.length} tools through Streamable HTTP at the API's \`/mcp\` endpoint. [Connect a client](/mcp-guide) before calling them. Read tools require \`health:read\`; record and goal writes require \`health:write\`. API-key administration is REST-only.\n\n| Tool | Purpose |\n| --- | --- |\n${toolTable}\n\nMutations require an \`idempotency_key\`. Reuse the same key and arguments when retrying. Corrections, voids and goal changes also require the current \`expected_version\`. See [record contracts](/records) and [goals](/goals).\n`,
    { parser: "mdx" },
  ),
);
console.log(
  check
    ? "Mintlify generated artifacts are current."
    : "Mintlify guides, tools, OpenAPI and brand assets generated.",
);
