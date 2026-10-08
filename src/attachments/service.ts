import { randomUUID } from "node:crypto";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
  attachments,
  attachmentIdempotency,
  recordAttachments,
  healthRecords,
  revisions,
} from "../db/schema.js";
import { DomainError, fail, parse } from "../errors.js";
import { hash } from "../domain/canonical.js";
import { Cursors } from "../domain/cursor.js";
import { boundedResponse } from "../domain/catalog.js";
import type { Data } from "../domain/types.js";
import { CATALOG_VERSION } from "../registry/definitions.js";
import {
  UPLOAD_LIFETIME_SECONDS,
  type Attachment,
} from "../registry/attachments.js";
import { idempotencyKey, type Operation } from "../registry/operations.js";
import type { AttachmentStorage, StoredAttachment } from "./storage.js";

export function attachmentFromRow(
  row: typeof attachments.$inferSelect,
): Attachment {
  return {
    id: row.id,
    filename: row.filename,
    content_type: row.contentType,
    byte_length: row.byteLength,
    sha256: row.sha256,
    status: row.status,
    created_at: new Date(row.createdAt).toISOString(),
    upload_expires_at: new Date(row.uploadExpiresAt).toISOString(),
    ready_at: row.readyAt ? new Date(row.readyAt).toISOString() : null,
  };
}
export function storedAttachment(
  row: typeof attachments.$inferSelect,
): StoredAttachment {
  return { ...attachmentFromRow(row), storage: row.storage };
}
export class Attachments {
  constructor(
    private db: Database,
    private cursors: Cursors,
    private storage?: AttachmentStorage,
  ) {}
  private requireStorage() {
    if (!this.storage)
      throw new DomainError(
        "UNAVAILABLE",
        "Configure S3-compatible storage to upload or download attachments",
      );
    return this.storage;
  }
  async execute(operation: Operation, raw: Data): Promise<Data> {
    if (operation.mutation)
      return boundedResponse(await this.mutate(operation, raw));
    const input = parse(operation.input, raw) as Data;
    if (operation.name === "health_list_attachments") return this.list(input);
    const [row] = await this.db
      .select()
      .from(attachments)
      .where(eq(attachments.id, String(input.id)));
    if (!row) throw new DomainError("NOT_FOUND", "Attachment does not exist");
    const result: Data = {
      catalog_version: CATALOG_VERSION,
      attachment: attachmentFromRow(row),
    };
    if (operation.name === "health_get_attachment_download") {
      if (row.status !== "ready")
        fail(
          "/id",
          "Only ready attachments can be downloaded",
          "attachment_not_ready",
        );
      result.download = await this.requireStorage().download(
        storedAttachment(row),
      );
    }
    return boundedResponse(result);
  }
  private async mutate(operation: Operation, raw: Data): Promise<Data> {
    const key = parse(idempotencyKey, raw.idempotency_key);
    const { idempotency_key: _key, ...domain } = raw;
    const digest = hash(domain);
    const storage = this.requireStorage();
    const committed = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(84309213, hashtext(${operation.name + ":" + key}))`,
      );
      const [previous] = await tx
        .select()
        .from(attachmentIdempotency)
        .where(
          and(
            eq(attachmentIdempotency.operation, operation.name),
            eq(attachmentIdempotency.idempotencyKey, key),
          ),
        );
      if (previous) {
        if (previous.requestHash !== digest)
          throw new DomainError(
            "IDEMPOTENCY_CONFLICT",
            "This key already committed a different request",
          );
        const [row] = await tx
          .select()
          .from(attachments)
          .where(eq(attachments.id, previous.attachmentId));
        if (!row)
          throw new DomainError(
            "INTERNAL_ERROR",
            "Committed attachment could not be retrieved",
          );
        return { row, snapshot: previous.snapshot, replay: true };
      }
      const input = parse(operation.input, raw) as Data;
      let row: typeof attachments.$inferSelect;
      if (operation.name === "health_create_attachment_upload") {
        const id = randomUUID();
        const now = new Date();
        const created = await tx
          .insert(attachments)
          .values({
            id,
            filename: String(input.filename),
            contentType: input.content_type as Attachment["content_type"],
            byteLength: Number(input.byte_length),
            sha256: String(input.sha256),
            status: "pending",
            storage: storage.location(id),
            createdAt: now.toISOString(),
            uploadExpiresAt: new Date(
              now.getTime() + UPLOAD_LIFETIME_SECONDS * 1000,
            ).toISOString(),
          })
          .returning();
        row = created[0]!;
      } else {
        const [current] = await tx
          .select()
          .from(attachments)
          .where(eq(attachments.id, String(input.id)))
          .for("update");
        if (!current)
          throw new DomainError("NOT_FOUND", "Attachment does not exist");
        row = current;
        if (row.status !== "ready") {
          if (
            row.status === "expired" ||
            new Date(row.uploadExpiresAt).getTime() <= Date.now()
          )
            fail(
              "/id",
              "Upload expired; reserve a new attachment with a new idempotency key",
              "upload_expired",
            );
          await storage.complete(storedAttachment(row));
          const [ready] = await tx
            .update(attachments)
            .set({ status: "ready", readyAt: new Date().toISOString() })
            .where(eq(attachments.id, row.id))
            .returning();
          row = ready!;
        }
      }
      const snapshot = attachmentFromRow(row);
      await tx.insert(attachmentIdempotency).values({
        operation: operation.name,
        idempotencyKey: key,
        requestHash: digest,
        attachmentId: row.id,
        snapshot,
      });
      return { row, snapshot, replay: false };
    });
    const result: Data = {
      catalog_version: CATALOG_VERSION,
      attachment: committed.snapshot,
      idempotent_replay: committed.replay,
    };
    if (operation.name === "health_create_attachment_upload") {
      result.upload =
        committed.row.status === "pending"
          ? await storage.upload(storedAttachment(committed.row))
          : null;
    }
    return result;
  }
  private async list(input: Data): Promise<Data> {
    if (input.record_version !== undefined && !input.record_id)
      fail("/record_version", "A record version requires record_id");
    const { cursor, ...supplied } = input;
    let recordVersion: number | undefined;
    if (input.record_id) {
      const [record] = await this.db
        .select({ version: healthRecords.version })
        .from(healthRecords)
        .where(eq(healthRecords.id, String(input.record_id)));
      if (!record) throw new DomainError("NOT_FOUND", "Record does not exist");
      recordVersion = Number(input.record_version ?? record.version);
      const [revision] = await this.db
        .select({ version: revisions.version })
        .from(revisions)
        .where(
          and(
            eq(revisions.recordId, String(input.record_id)),
            eq(revisions.version, recordVersion),
          ),
        );
      if (!revision)
        throw new DomainError("NOT_FOUND", "Record version does not exist");
    }
    const limit = Number(input.limit ?? 50);
    const filters = {
      domain: "attachments",
      ...supplied,
      record_version: recordVersion,
      limit,
    };
    const position = cursor
      ? this.cursors.decode(String(cursor), filters)
      : undefined;
    const rows = await this.db
      .select()
      .from(attachments)
      .where(
        and(
          input.status
            ? eq(attachments.status, input.status as Attachment["status"])
            : undefined,
          input.record_id
            ? sql`exists (select 1 from ${recordAttachments} where ${recordAttachments.attachmentId} = ${attachments.id} and ${recordAttachments.recordId} = ${String(input.record_id)} and ${recordAttachments.recordVersion} = ${recordVersion!})`
            : undefined,
          position
            ? or(
                lt(attachments.createdAt, String(position.created_at)),
                and(
                  eq(attachments.createdAt, String(position.created_at)),
                  lt(attachments.id, String(position.id)),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(attachments.createdAt), desc(attachments.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return boundedResponse({
      catalog_version: CATALOG_VERSION,
      attachments: page.map(attachmentFromRow),
      returned_count: page.length,
      has_more: rows.length > limit,
      next_cursor:
        rows.length > limit && last
          ? this.cursors.encode(filters, {
              created_at: new Date(last.createdAt).toISOString(),
              id: last.id,
            })
          : null,
    });
  }
}
