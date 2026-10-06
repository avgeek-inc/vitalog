import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

type Profile = {
  deployment: {
    resources: { memory: string; cpus: number };
    dockerfile: string;
    architecture: "arm64" | "amd64";
  };
};
const docker = (args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
    timeout: 600_000,
  }).trim();
const checks = [];
const peakMemory = `node -e 'const fs = require("node:fs"); const path = "/sys/fs/cgroup/memory.peak"; console.log(JSON.stringify({peak_memory_bytes: fs.existsSync(path) ? Number(fs.readFileSync(path, "utf8")) : null}))'`;

for (const name of ["api", "web"] as const) {
  const manifest = parse(
    await readFile(
      `.towbar/services/vitalog${name === "web" ? "-web" : ""}.service.yml`,
      "utf8",
    ),
  ) as Profile;
  const { memory, cpus } = manifest.deployment.resources;
  const { architecture } = manifest.deployment;
  assert(["arm64", "amd64"].includes(architecture));
  const platform = `linux/${architecture}`;
  const dockerfile = await readFile(manifest.deployment.dockerfile, "utf8");
  const image = /^FROM (\S+) AS build$/m.exec(dockerfile)?.[1];
  assert(image, "The budget check needs the production builder image");
  const context = await mkdtemp(join(tmpdir(), "vitalog-build-budget-"));
  const container = `vitalog-${name}-build-budget-${process.pid}`;
  let created = false;
  try {
    for (const file of [
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "tsconfig.build.json",
    ])
      await cp(file, join(context, file));
    for (const folder of ["src", "scripts", "drizzle", "vendor"])
      await cp(folder, join(context, folder), { recursive: true });
    await mkdir(join(context, "apps"));
    await cp("apps/web", join(context, "apps/web"), {
      recursive: true,
      filter: (path) =>
        !path
          .split("/")
          .some(
            (part) =>
              [".next", "node_modules"].includes(part) ||
              part.startsWith(".env"),
          ) && !path.endsWith(".tsbuildinfo"),
    });
    docker([
      "create",
      "--name",
      container,
      `--platform=${platform}`,
      `--memory=${memory}`,
      `--memory-swap=${memory}`,
      `--cpus=${cpus}`,
      "--workdir",
      "/app",
      "--env",
      "NEXT_TELEMETRY_DISABLED=1",
      image,
      "sh",
      "-c",
      name === "api"
        ? `npm ci --workspaces=false && npm run build:api && npm prune --omit=dev --workspaces=false && node --input-type=module -e 'await import("./dist/src/app.js")' && ${peakMemory}`
        : `npm ci && npm run build:web && ${peakMemory}`,
    ]);
    created = true;
    docker(["cp", context + "/.", container + ":/app"]);
    let output = "";
    try {
      output = docker(["start", "-a", container]);
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      output = String(failure.stdout ?? "") + String(failure.stderr ?? "");
    }
    const state = JSON.parse(
      docker(["inspect", "--format", "{{json .State}}", container]),
    ) as { ExitCode: number; OOMKilled: boolean; Status: string };
    assert.equal(
      state.ExitCode,
      0,
      `${name} builder failed within ${memory}:\n${output.slice(-3000)}`,
    );
    assert.equal(state.OOMKilled, false);
    assert.equal(state.Status, "exited");
    const peak = /^\{"peak_memory_bytes":(\d+|null)\}$/m.exec(output);
    assert(peak, "The builder must report whether peak memory is available");
    checks.push({
      name,
      memory,
      cpus,
      platform,
      swap: false,
      image,
      status: "passed",
      peak_memory_bytes: peak[1] === "null" ? null : Number(peak[1]),
    });
    process.stdout.write(
      `PASS ${name} ${platform} production build within ${memory} and ${cpus} CPU without swap\n`,
    );
  } finally {
    if (created) docker(["rm", "--force", container]);
    await rm(context, { recursive: true, force: true });
  }
}
await mkdir(".test-artifacts", { recursive: true });
await writeFile(
  ".test-artifacts/build-budget.json",
  JSON.stringify({ status: "passed", checks }, null, 2) + "\n",
);
