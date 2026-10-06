import { createHash } from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { fileTypeFromBuffer } from "file-type";
import { DomainError } from "../errors.js";
import type { Attachment } from "../registry/attachments.js";
import {
  MAX_ATTACHMENT_BYTES,
  DOWNLOAD_LIFETIME_SECONDS,
} from "../registry/attachments.js";
import type { AttachmentStorageConfig } from "./config.js";

export type StorageLocation = {
  bucket: string;
  origin: string;
  upload_key: string;
  object_key: string;
};
export type StoredAttachment = Attachment & { storage: StorageLocation };
export interface AttachmentStorage {
  location(id: string): StorageLocation;
  upload(attachment: StoredAttachment): Promise<{
    method: "PUT";
    url: string;
    headers: {
      "Content-Type": Attachment["content_type"];
      "Content-Length": string;
    };
    expires_at: string;
  }>;
  complete(attachment: StoredAttachment): Promise<void>;
  download(
    attachment: StoredAttachment,
  ): Promise<{ method: "GET"; url: string; expires_at: string }>;
  discardUpload(attachment: StoredAttachment): Promise<void>;
  erase(locations: StorageLocation[]): Promise<void>;
}

export async function verifyAttachmentBytes(
  attachment: Pick<Attachment, "byte_length" | "sha256" | "content_type">,
  bytes: Uint8Array,
) {
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES)
    throw new DomainError(
      "LIMIT_EXCEEDED",
      "Files must not exceed 20 MB (20,000,000 bytes)",
    );
  if (bytes.byteLength !== attachment.byte_length)
    throw new DomainError(
      "VALIDATION_ERROR",
      "The uploaded file size does not match the reserved attachment",
    );
  if (createHash("sha256").update(bytes).digest("hex") !== attachment.sha256)
    throw new DomainError(
      "VALIDATION_ERROR",
      "The uploaded file checksum does not match the reserved attachment",
    );
  const detected = await fileTypeFromBuffer(bytes).catch(() => undefined);
  if (detected?.mime !== attachment.content_type)
    throw new DomainError(
      "VALIDATION_ERROR",
      "File bytes do not match the declared image or PDF type",
    );
}

const encodedFilename = (filename: string) =>
  encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase(),
  );
const unavailable = () =>
  new DomainError(
    "UNAVAILABLE",
    "Attachment storage is unavailable; retry with the same idempotency key",
  );
export class S3AttachmentStorage implements AttachmentStorage {
  private client: S3Client;
  private completing = 0;
  constructor(private config: AttachmentStorageConfig) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      maxAttempts: 2,
    });
  }
  private key(id: string, stage: "uploads" | "objects") {
    return `${this.config.prefix}/${stage}/${id}`;
  }
  location(id: string): StorageLocation {
    return {
      bucket: this.config.bucket,
      origin: this.config.endpoint
        ? new URL(this.config.endpoint).origin
        : `aws:${this.config.region}`,
      upload_key: this.key(id, "uploads"),
      object_key: this.key(id, "objects"),
    };
  }
  private assertLocation(attachment: StoredAttachment) {
    const configured = this.location(attachment.id);
    if (
      attachment.storage.bucket !== configured.bucket ||
      attachment.storage.origin !== configured.origin
    )
      throw new DomainError(
        "UNAVAILABLE",
        "Attachment storage configuration does not match the stored file location",
      );
  }
  async upload(attachment: StoredAttachment) {
    this.assertLocation(attachment);
    const expiresIn = Math.floor(
      (new Date(attachment.upload_expires_at).getTime() - Date.now()) / 1000,
    );
    if (expiresIn <= 0)
      throw new DomainError(
        "VALIDATION_ERROR",
        "Upload expired; reserve a new attachment with a new idempotency key",
      );
    try {
      const url = await getSignedUrl(
        this.client,
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: attachment.storage.upload_key,
          ContentType: attachment.content_type,
          ContentLength: attachment.byte_length,
        }),
        {
          expiresIn,
          signableHeaders: new Set(["content-type", "content-length"]),
        },
      );
      return {
        method: "PUT" as const,
        url,
        headers: {
          "Content-Type": attachment.content_type,
          "Content-Length": String(attachment.byte_length),
        },
        expires_at: attachment.upload_expires_at,
      };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw unavailable();
    }
  }
  async complete(attachment: StoredAttachment) {
    this.assertLocation(attachment);
    if (this.completing >= 2)
      throw new DomainError(
        "RATE_LIMITED",
        "Attachment verification is busy; retry with the same idempotency key",
      );
    this.completing++;
    const signal = AbortSignal.timeout(20_000);
    try {
      const key = attachment.storage.upload_key;
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
        { abortSignal: signal },
      );
      if ((head.ContentLength ?? Infinity) > MAX_ATTACHMENT_BYTES)
        throw new DomainError(
          "LIMIT_EXCEEDED",
          "Files must not exceed 20 MB (20,000,000 bytes)",
        );
      if (
        head.ContentLength !== attachment.byte_length ||
        head.ContentType !== attachment.content_type
      )
        throw new DomainError(
          "VALIDATION_ERROR",
          "The uploaded size or content type does not match the reserved attachment",
        );
      if (!head.ETag) throw unavailable();
      const object = await this.client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          IfMatch: head.ETag,
        }),
        { abortSignal: signal },
      );
      if (!object.Body) throw unavailable();
      const body = object.Body as AsyncIterable<Uint8Array> & {
        destroy?: () => void;
      };
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for await (const chunk of body) {
          length += chunk.byteLength;
          if (length > Math.min(MAX_ATTACHMENT_BYTES, attachment.byte_length))
            throw new DomainError(
              "LIMIT_EXCEEDED",
              "Uploaded file exceeds its reserved size",
            );
          chunks.push(chunk);
        }
      } finally {
        body.destroy?.();
      }
      const bytes = Buffer.concat(chunks);
      await verifyAttachmentBytes(attachment, bytes);
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: attachment.storage.object_key,
          Body: bytes,
          ContentLength: bytes.byteLength,
          ContentType: attachment.content_type,
          ContentDisposition: `attachment; filename*=UTF-8''${encodedFilename(attachment.filename)}`,
          CacheControl: "private, no-store",
          Metadata: { sha256: attachment.sha256 },
        }),
        { abortSignal: signal },
      );
    } catch (error) {
      if (error instanceof DomainError) throw error;
      const status = (error as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      if (status === 404)
        throw new DomainError(
          "VALIDATION_ERROR",
          "Upload the file before completing the attachment",
        );
      if (status === 412)
        throw new DomainError(
          "VALIDATION_ERROR",
          "The upload changed during verification; retry completion",
        );
      throw unavailable();
    } finally {
      this.completing--;
    }
  }
  async download(attachment: StoredAttachment) {
    this.assertLocation(attachment);
    try {
      const url = await getSignedUrl(
        this.client,
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: attachment.storage.object_key,
          ResponseCacheControl: "private, no-store",
          ResponseContentDisposition: `attachment; filename*=UTF-8''${encodedFilename(attachment.filename)}`,
        }),
        { expiresIn: DOWNLOAD_LIFETIME_SECONDS },
      );
      return {
        method: "GET" as const,
        url,
        expires_at: new Date(
          Date.now() + DOWNLOAD_LIFETIME_SECONDS * 1000,
        ).toISOString(),
      };
    } catch {
      throw unavailable();
    }
  }
  async discardUpload(attachment: StoredAttachment) {
    this.assertLocation(attachment);
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.config.bucket,
          Key: attachment.storage.upload_key,
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
    } catch {
      throw unavailable();
    }
  }
  async erase(locations: StorageLocation[]) {
    const configured = this.location("");
    if (
      locations.some(
        (location) =>
          location.bucket !== configured.bucket ||
          location.origin !== configured.origin,
      )
    )
      throw new DomainError(
        "UNAVAILABLE",
        "Restore the matching storage configuration before erasing attachments",
      );
    for (const location of locations) {
      for (const key of [location.upload_key, location.object_key])
        await this.client.send(
          new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
          { abortSignal: AbortSignal.timeout(10_000) },
        );
    }
    let continuation: string | undefined;
    do {
      const listed = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: this.config.prefix + "/",
          ContinuationToken: continuation,
        }),
        { abortSignal: AbortSignal.timeout(10_000) },
      );
      for (const object of listed.Contents ?? [])
        if (object.Key)
          await this.client.send(
            new DeleteObjectCommand({
              Bucket: this.config.bucket,
              Key: object.Key,
            }),
            { abortSignal: AbortSignal.timeout(10_000) },
          );
      continuation = listed.IsTruncated
        ? listed.NextContinuationToken
        : undefined;
    } while (continuation);
  }
}
