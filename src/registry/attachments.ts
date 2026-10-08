import { z } from "zod";
import { CATALOG_VERSION } from "./definitions.js";
import * as p from "./primitives.js";

export const MAX_ATTACHMENT_BYTES = 20_000_000;
export const UPLOAD_LIFETIME_SECONDS = 15 * 60;
export const DOWNLOAD_LIFETIME_SECONDS = 5 * 60;
export const attachmentContentTypes = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/heic",
  "image/heif",
  "image/tiff",
  "image/bmp",
] as const;
export const attachmentIds = z
  .array(z.uuid())
  .max(20)
  .refine(
    (ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length,
    "Attachment IDs must be unique within a record",
  );
export const attachmentFile = {
  filename: p
    .text(200)
    .regex(
      /^[^/\\\x00-\x1f\x7f]+$/,
      "Use a filename without paths or control characters",
    )
    .refine(
      (filename) => !/[\uD800-\uDFFF]/u.test(filename),
      "Use a valid Unicode filename",
    ),
  content_type: z.enum(attachmentContentTypes),
  byte_length: z.number().int().min(1).max(MAX_ATTACHMENT_BYTES),
  sha256: z
    .string()
    .regex(
      /^[0-9a-f]{64}$/,
      "Use the lowercase SHA-256 hex digest of the file",
    ),
};
export const attachmentSchema = z.strictObject({
  id: z.uuid(),
  ...attachmentFile,
  status: z.enum(["pending", "ready", "expired"]),
  created_at: p.instant,
  upload_expires_at: p.instant,
  ready_at: p.instant.nullable(),
});
export type Attachment = z.infer<typeof attachmentSchema>;
const metadata = { catalog_version: z.literal(CATALOG_VERSION) };
const uploadSchema = z.strictObject({
  method: z.literal("PUT"),
  url: z.url(),
  headers: z.strictObject({
    "Content-Type": z.enum(attachmentContentTypes),
    "Content-Length": p.text(20),
  }),
  expires_at: p.instant,
});
export function attachmentOperations(idempotencyKey: z.ZodString) {
  return [
    {
      name: "health_create_attachment_upload",
      method: "POST" as const,
      path: "/v1/attachments/uploads",
      mutation: true,
      input: z.strictObject({
        idempotency_key: idempotencyKey,
        ...attachmentFile,
      }),
      output: z.strictObject({
        ...metadata,
        attachment: attachmentSchema,
        upload: uploadSchema.nullable(),
        idempotent_replay: z.boolean(),
      }),
      description:
        "Reserve one reusable image or PDF attachment (maximum 20 MB / 20,000,000 bytes). Supply its actual filename, MIME type, byte length and SHA-256. Send the original binary file with HTTP PUT to the returned signed URL and headers within 15 minutes; do not send ledger credentials to storage. Then call health_complete_attachment_upload. Files are not automatically transferred by MCP. Never invent a file or checksum.",
    },
    {
      name: "health_complete_attachment_upload",
      method: "POST" as const,
      path: "/v1/attachments/{id}/complete",
      mutation: true,
      input: z.strictObject({ id: z.uuid(), idempotency_key: idempotencyKey }),
      output: z.strictObject({
        ...metadata,
        attachment: attachmentSchema,
        idempotent_replay: z.boolean(),
      }),
      description:
        "Verify an uploaded file's bytes, size, SHA-256 and image/PDF type, and make the attachment immutable and ready. Only ready IDs can be supplied in attachment_ids when logging or correcting any record. Reuse one ID across nutrition, measurements or a lab-results batch without uploading again. Retry failures with the same idempotency key.",
    },
    {
      name: "health_get_attachment",
      method: "GET" as const,
      path: "/v1/attachments/{id}",
      mutation: false,
      input: z.strictObject({ id: z.uuid() }),
      output: z.strictObject({ ...metadata, attachment: attachmentSchema }),
      description:
        "Get attachment metadata and upload state. This does not return file bytes or a download URL.",
    },
    {
      name: "health_list_attachments",
      method: "GET" as const,
      path: "/v1/attachments",
      mutation: false,
      input: z.strictObject({
        record_id: z.uuid().optional(),
        record_version: z.number().int().positive().optional(),
        status: z.enum(["pending", "ready", "expired"]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: p.text(2000).optional(),
      }),
      output: z.strictObject({
        ...metadata,
        attachments: z.array(attachmentSchema).max(100),
        returned_count: p.count,
        has_more: z.boolean(),
        next_cursor: p.text(2000).nullable(),
      }),
      description:
        "List reusable attachments with cursor pagination. Optionally filter by a record and its version; without a version, use that record's current attachments. Omitting record_id lists the ledger's attachments. No file contents or signed URLs are returned.",
    },
    {
      name: "health_get_attachment_download",
      method: "GET" as const,
      path: "/v1/attachments/{id}/download",
      mutation: false,
      input: z.strictObject({ id: z.uuid() }),
      output: z.strictObject({
        ...metadata,
        attachment: attachmentSchema,
        download: z.strictObject({
          method: z.literal("GET"),
          url: z.url(),
          expires_at: p.instant,
        }),
      }),
      description:
        "Get a private, signed download URL for a ready attachment, valid for five minutes. Treat the URL as sensitive temporary access and do not save it in records. Download the file outside MCP; health data and attachment metadata stay separate.",
    },
  ];
}
