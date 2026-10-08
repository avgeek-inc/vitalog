import { describe, expect, test } from "vitest";
import { releaseImages } from "../scripts/release-images.js";

const manifest = {
  version: "v1.0.2",
  commit: "a".repeat(40),
  platforms: ["linux/amd64", "linux/arm64"],
  images: {
    api: `ghcr.io/avgeek-oss/vitalog-api@sha256:${"b".repeat(64)}`,
    web: `ghcr.io/avgeek-oss/vitalog-web@sha256:${"c".repeat(64)}`,
  },
};

describe("release image promotion contract", () => {
  test("accepts the complete immutable release", () => {
    expect(releaseImages.parse(manifest)).toEqual(manifest);
  });
  test.each([
    { ...manifest, version: "latest" },
    { ...manifest, version: "v01.0.2" },
    { ...manifest, commit: "main" },
    { ...manifest, platforms: ["linux/arm64"] },
    {
      ...manifest,
      images: {
        ...manifest.images,
        api: "ghcr.io/avgeek-oss/vitalog-api:v1.0.2",
      },
    },
    { ...manifest, images: { ...manifest.images, api: manifest.images.web } },
    { ...manifest, images: { api: manifest.images.api } },
    {
      ...manifest,
      images: { ...manifest.images, worker: manifest.images.api },
    },
  ])("rejects incomplete or mutable release metadata %#", (candidate) => {
    expect(releaseImages.safeParse(candidate).success).toBe(false);
  });
});
