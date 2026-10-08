import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const reference = (repository: string) =>
  z
    .string()
    .regex(
      new RegExp(`^ghcr\\.io/avgeek-oss/${repository}@sha256:[0-9a-f]{64}$`),
    );
export const releaseImages = z
  .object({
    version: z
      .string()
      .regex(/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    platforms: z.tuple([z.literal("linux/amd64"), z.literal("linux/arm64")]),
    images: z
      .object({
        api: reference("vitalog-api"),
        web: reference("vitalog-web"),
      })
      .strict(),
  })
  .strict();
export type ReleaseImages = z.infer<typeof releaseImages>;
export async function readReleaseImages(path: string): Promise<ReleaseImages> {
  return releaseImages.parse(JSON.parse(await readFile(path, "utf8")));
}

async function inspectImage(repository: string, tag: string, commit: string) {
  const auth = await fetch(
    `https://ghcr.io/token?service=ghcr.io&scope=repository:avgeek-oss/${repository}:pull`,
  );
  assert(
    auth.ok,
    `${repository}: anonymous pull token failed (${auth.status}); make the package public`,
  );
  const { token } = z.object({ token: z.string() }).parse(await auth.json());
  const request = async (path: string) => {
    const response = await fetch(
      `https://ghcr.io/v2/avgeek-oss/${repository}/${path}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept:
            "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json",
        },
      },
    );
    assert(
      response.ok,
      `${repository}: registry request failed (${response.status})`,
    );
    const body = Buffer.from(await response.arrayBuffer());
    const hash = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    const declared = response.headers.get("docker-content-digest");
    if (declared) assert.equal(hash, declared);
    return { hash, value: JSON.parse(body.toString("utf8")) as unknown };
  };
  const index = await request(`manifests/${tag}`);
  const { manifests } = z
    .object({
      manifests: z.array(
        z.object({
          digest,
          platform: z.object({ os: z.string(), architecture: z.string() }),
        }),
      ),
    })
    .parse(index.value);
  for (const architecture of ["amd64", "arm64"]) {
    const matches = manifests.filter(
      (item) =>
        item.platform.os === "linux" &&
        item.platform.architecture === architecture,
    );
    assert.equal(
      matches.length,
      1,
      `${repository}: expected one linux/${architecture} image`,
    );
    const manifest = await request(`manifests/${matches[0]!.digest}`);
    assert.equal(manifest.hash, matches[0]!.digest);
    const { config } = z
      .object({ config: z.object({ digest }) })
      .parse(manifest.value);
    const blob = await request(`blobs/${config.digest}`);
    assert.equal(blob.hash, config.digest);
    const image = z
      .object({
        os: z.string(),
        architecture: z.string(),
        config: z.object({ Labels: z.record(z.string(), z.string()) }),
      })
      .parse(blob.value);
    assert.equal(image.os, "linux");
    assert.equal(image.architecture, architecture);
    assert.equal(
      image.config.Labels["org.opencontainers.image.revision"],
      commit,
    );
    assert.equal(
      image.config.Labels["org.opencontainers.image.version"],
      tag.slice(1),
    );
  }
  return `ghcr.io/avgeek-oss/${repository}@${index.hash}`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [tag, commit, output] = process.argv.slice(2);
  assert(
    tag && commit && output,
    "Usage: release-images.ts <tag> <commit> <output>",
  );
  releaseImages.shape.version.parse(tag);
  releaseImages.shape.commit.parse(commit);
  const manifest = releaseImages.parse({
    version: tag,
    commit,
    platforms: ["linux/amd64", "linux/arm64"],
    images: {
      api: await inspectImage("vitalog-api", tag, commit),
      web: await inspectImage("vitalog-web", tag, commit),
    },
  });
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, JSON.stringify(manifest, null, 2) + "\n");
  process.stdout.write(
    `Verified anonymous access, platforms and source revision for ${tag}\n`,
  );
}
