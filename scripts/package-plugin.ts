import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";

const root = resolve("plugin");
const output = resolve("dist/vitalog-plugin.zip");
const files = [
  "plugin.json",
  "mcp.json",
  "README.md",
  "assets/icon.png",
  "assets/logo.png",
  "skills/vitalog/SKILL.md",
];
const ajv = new Ajv2020({ strict: false });
for (const name of ["plugin", "mcp"]) {
  const schema = JSON.parse(
    await readFile(`schemas/plugins/${name}.schema.json`, "utf8"),
  );
  const document = JSON.parse(await readFile(`${root}/${name}.json`, "utf8"));
  const validate = ajv.compile(schema);
  assert(validate(document), ajv.errorsText(validate.errors));
}
const manifest = JSON.parse(await readFile(`${root}/plugin.json`, "utf8"));
const servers = JSON.parse(
  await readFile(`${root}/mcp.json`, "utf8"),
).mcpServers;
assert.deepEqual(Object.keys(servers), ["vitalog"]);
assert.deepEqual(servers.vitalog, {
  type: "streamable-http",
  url: "https://vitalog-api.praveent.com/mcp",
});
for (const name of ["composerIcon", "logo"]) {
  const path = manifest.extensions["com.openai"].interface[name];
  assert(
    files.includes(path.replace(/^\.\//, "")),
    "Brand assets must be in the package",
  );
}
for (const file of files) {
  assert((await stat(`${root}/${file}`)).isFile());
  if (file.endsWith(".png")) {
    const png = await readFile(`${root}/${file}`);
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png[25], 6, "Brand PNGs must preserve RGBA transparency");
  } else {
    const text = await readFile(`${root}/${file}`, "utf8");
    assert(
      !/v(?:lk|lo)_[A-Za-z0-9_-]{43}|Bearer\s+[A-Za-z0-9._~+/=-]{43,}|sk-[A-Za-z0-9_-]{20,}/.test(
        text,
      ),
      "Credentials must not be packaged",
    );
  }
}
assert.deepEqual(
  await readFile(`${root}/assets/icon.png`),
  await readFile("apps/web/public/brand/vitalog-favicon.png"),
);
assert.deepEqual(
  await readFile(`${root}/assets/logo.png`),
  await readFile("apps/web/public/brand/vitalog-mark.png"),
);
await mkdir("dist", { recursive: true });
await rm(output, { force: true });
execFileSync("zip", ["-X", "-q", output, ...files], { cwd: root });
execFileSync("unzip", ["-tqq", output]);
const entries = execFileSync("unzip", ["-Z1", output], { encoding: "utf8" })
  .trim()
  .split("\n");
assert.deepEqual(entries.sort(), [...files].sort());
for (const file of files)
  assert.deepEqual(
    execFileSync("unzip", ["-p", output, file]),
    await readFile(`${root}/${file}`),
  );
process.stdout.write(
  `Validated Agent Plugins manifests, transparent brand assets and ${files.length} archive files: dist/vitalog-plugin.zip\n`,
);
