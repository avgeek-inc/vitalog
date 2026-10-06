import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { attachmentStorageConfiguration } from "../src/attachments/config.js";
import {
  S3AttachmentStorage,
  verifyAttachmentBytes,
} from "../src/attachments/storage.js";
import { configuration } from "../src/config.js";
import {
  MAX_ATTACHMENT_BYTES,
  attachmentIds,
} from "../src/registry/attachments.js";
import { operationByName } from "../src/registry/operations.js";
import { normalizeInput } from "../src/domain/validation.js";
import { examples } from "./fixtures.js";
import { fileMetadata, png, gif, pdf } from "./attachment-fixtures.js";

const storageConfig = attachmentStorageConfiguration({
  S3_BUCKET: "test-attachments",
  S3_ENDPOINT: "http://127.0.0.1:9000",
  S3_ACCESS_KEY_ID: "test-access-key",
  S3_SECRET_ACCESS_KEY: randomBytes(32).toString("hex"),
})!;
describe("Reusable attachment contracts", () => {
  test.each([
    [png, "image/png"],
    [gif, "image/gif"],
    [pdf, "application/pdf"],
  ] as const)("Verifies original fixture bytes as %s", async (bytes, type) => {
    await expect(
      verifyAttachmentBytes(fileMetadata(bytes, type), bytes),
    ).resolves.toBeUndefined();
  });
  test("Rejects size, checksum, MIME spoofing and active SVG", async () => {
    await expect(
      verifyAttachmentBytes(
        { ...fileMetadata(png), byte_length: png.length + 1 },
        png,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      verifyAttachmentBytes(
        { ...fileMetadata(png), sha256: "0".repeat(64) },
        png,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      verifyAttachmentBytes(fileMetadata(png, "application/pdf"), png),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const svg = Buffer.from('<svg onload="alert(1)"></svg>');
    await expect(
      verifyAttachmentBytes(fileMetadata(svg), svg),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const oversize = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1);
    await expect(
      verifyAttachmentBytes(fileMetadata(oversize), oversize),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });
  test("Reservation caps files at exactly 20 MB with bounded metadata", () => {
    const input = operationByName.get("health_create_attachment_upload")!.input;
    const valid = {
      ...fileMetadata(pdf, "application/pdf", "report.pdf"),
      byte_length: MAX_ATTACHMENT_BYTES,
      idempotency_key: "unit-reserve",
    };
    expect(input.safeParse(valid).success).toBe(true);
    for (const replacement of [
      { byte_length: 0 },
      { byte_length: MAX_ATTACHMENT_BYTES + 1 },
      { byte_length: 1.1 },
      { content_type: "image/svg+xml" },
      { filename: "../report.pdf" },
      { filename: "report\r\nheader.pdf" },
      { filename: "report\uD800.pdf" },
      { sha256: "not-a-digest" },
      { sha256: "A".repeat(64) },
      { source_url: "http://localhost/private" },
    ])
      expect(input.safeParse({ ...valid, ...replacement }).success).toBe(false);
  });
  test("Every record type can reuse the same bounded set of IDs", () => {
    const ids = ["00000000-0000-4000-8000-00000000abcd", randomUUID()];
    for (const [type, input] of Object.entries(examples)) {
      expect(
        normalizeInput(
          type as keyof typeof examples,
          { ...input, attachment_ids: ids.map((id) => id.toUpperCase()) },
          "Asia/Kolkata",
        ).attachment_ids,
      ).toEqual(ids);
    }
    expect(attachmentIds.safeParse([ids[0], ids[0]]).success).toBe(false);
    expect(
      attachmentIds.safeParse([ids[0], ids[0]!.toUpperCase()]).success,
    ).toBe(false);
    expect(
      attachmentIds.safeParse(Array.from({ length: 21 }, () => randomUUID()))
        .success,
    ).toBe(false);
    expect(attachmentIds.safeParse([]).success).toBe(true);
  });
  test("Signed upload restricts method, exact byte length, MIME type and staging key", async () => {
    const storage = new S3AttachmentStorage(storageConfig);
    const id = randomUUID();
    const attachment = {
      ...fileMetadata(png),
      id,
      status: "pending" as const,
      created_at: new Date().toISOString(),
      upload_expires_at: new Date(Date.now() + 900_000).toISOString(),
      ready_at: null,
      storage: storage.location(id),
    };
    const upload = await storage.upload(attachment);
    const url = new URL(upload.url);
    expect(url.pathname).toBe(`/test-attachments/vitalog/uploads/${id}`);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-length;content-type;host",
    );
    expect(Number(url.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(
      900,
    );
    expect(upload.headers).toEqual({
      "Content-Length": String(png.length),
      "Content-Type": "image/png",
    });
    expect(upload.url).not.toContain(storageConfig.secretAccessKey);
    await expect(
      storage.upload({
        ...attachment,
        upload_expires_at: new Date(0).toISOString(),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      storage.download({
        ...attachment,
        storage: { ...attachment.storage, bucket: "other-bucket" },
      }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
  test("Storage is optional, partial configuration fails and secrets cannot enter records", () => {
    expect(attachmentStorageConfiguration({})).toBeUndefined();
    for (const env of [
      { S3_ENDPOINT: "https://storage.example.com" },
      { S3_BUCKET: "files" },
      {
        S3_BUCKET: "files",
        S3_ACCESS_KEY_ID: "access",
        S3_SECRET_ACCESS_KEY: "password",
        S3_ENDPOINT: "http://storage.example.com",
      },
      {
        S3_BUCKET: "files",
        S3_ACCESS_KEY_ID: "access",
        S3_SECRET_ACCESS_KEY: "password",
        S3_PREFIX: "../other",
      },
    ])
      expect(() => attachmentStorageConfiguration(env)).toThrow();
    const env = {
      AUTH_KEY: randomBytes(48).toString("base64url"),
      DATABASE_URL: "postgresql://unused.invalid/attachments",
      S3_BUCKET: storageConfig.bucket,
      S3_ACCESS_KEY_ID: storageConfig.accessKeyId,
      S3_SECRET_ACCESS_KEY: storageConfig.secretAccessKey,
    };
    const config = configuration(env);
    expect(() =>
      config.assertCredentialAbsent(storageConfig.secretAccessKey),
    ).toThrow();
    expect(() =>
      configuration({ ...env, S3_SECRET_ACCESS_KEY: env.AUTH_KEY }),
    ).toThrow("S3_SECRET_ACCESS_KEY must differ");
  });
});
