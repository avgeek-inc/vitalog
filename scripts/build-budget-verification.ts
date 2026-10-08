import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const docker = (args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
    timeout: 600_000,
  }).trim();
const checks = [];
const peakMemory = `node -e 'const fs = require("node:fs"); const path = "/sys/fs/cgroup/memory.peak"; const events = "/sys/fs/cgroup/memory.events"; const kills = fs.existsSync(events) ? /^oom_kill\\s+(\\d+)$/m.exec(fs.readFileSync(events, "utf8")) : null; console.log(JSON.stringify({peak_memory_bytes: fs.existsSync(path) ? Number(fs.readFileSync(path, "utf8")) : null, oom_kills: kills ? Number(kills[1]) : null}))'`;

for (const name of ["api", "web"] as const) {
  const memory = name === "api" ? "512m" : "1g";
  const cpus = 1;
  assert(["arm64", "x64"].includes(process.arch));
  const dockerPlatform = `linux/${process.arch === "x64" ? "amd64" : "arm64"}`;
  const dockerfile = await readFile(
    name === "api" ? "Dockerfile" : "apps/web/Dockerfile",
    "utf8",
  );
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
      `--platform=${dockerPlatform}`,
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
        ? `npm ci --workspaces=false && npm run build:api && npm prune --omit=dev --workspaces=false && node --input-type=module -e 'await import("./dist/src/app.js")'; build_result=$?; ${peakMemory}; exit "$build_result"`
        : `npm ci && node --run build:web; build_result=$?; ${peakMemory}; exit "$build_result"`,
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
    const peak =
      /^\{"peak_memory_bytes":(\d+|null),"oom_kills":(\d+|null)\}$/m.exec(
        output,
      );
    assert(peak, "The builder must report whether peak memory is available");
    assert(
      ["0", "null"].includes(peak[2]!),
      "No build process may be OOM killed",
    );
    checks.push({
      name,
      memory,
      cpus,
      platform: dockerPlatform,
      swap: false,
      image,
      status: "passed",
      peak_memory_bytes: peak[1] === "null" ? null : Number(peak[1]),
      oom_kills: peak[2] === "null" ? null : Number(peak[2]),
    });
    process.stdout.write(
      `PASS ${name} ${dockerPlatform} CI build within ${memory} and ${cpus} CPU without swap\n`,
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
