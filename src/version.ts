import { existsSync, readFileSync } from "node:fs";

const sourceManifest = new URL("../package.json", import.meta.url);
const manifest = JSON.parse(
  readFileSync(
    existsSync(sourceManifest)
      ? sourceManifest
      : new URL("../../package.json", import.meta.url),
    "utf8",
  ),
) as { version: string };

export const vitalogVersion = manifest.version;
