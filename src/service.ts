import { sql } from "drizzle-orm";
import type { Database } from "./db/client.js";
import { parse, DomainError } from "./errors.js";
import { catalog, boundedResponse } from "./domain/catalog.js";
import { Cursors } from "./domain/cursor.js";
import { Reads } from "./domain/reads.js";
import { Store } from "./domain/store.js";
import { Goals } from "./domain/goals.js";
import { Attachments } from "./attachments/service.js";
import type { AttachmentStorage } from "./attachments/storage.js";
import type { Data } from "./domain/types.js";
import { accountTimezone } from "./auth/account.js";
import { idempotencyKey, operationByName } from "./registry/operations.js";

export class Service {
  private cursors: Cursors;
  private attachments: Attachments;
  constructor(
    public db: Database,
    cursorKey: string,
    attachmentStorage?: AttachmentStorage,
  ) {
    this.cursors = new Cursors(cursorKey);
    this.attachments = new Attachments(db, this.cursors, attachmentStorage);
  }
  async ready(): Promise<boolean> {
    try {
      await this.db.execute(
        sql`select id, attachment_ids from health_records limit 0`,
      );
      await this.db.execute(
        sql`select id, storage, status, sha256 from attachments limit 0`,
      );
      await this.db.execute(
        sql`select record_id, record_version, attachment_id from record_attachments limit 0`,
      );
      await this.db.execute(
        sql`select operation, idempotency_key, snapshot from attachment_idempotency_requests limit 0`,
      );
      await this.db.execute(
        sql`select id, time_context from health_records limit 0`,
      );
      await this.db.execute(
        sql`select id, name, access, include_admin, token_digest, expires_at, revoked_at from api_keys limit 0`,
      );
      await this.db.execute(
        sql`select code_digest, code_challenge, consumed_at from oauth_authorization_codes limit 0`,
      );
      await this.db.execute(
        sql`select token_digest, resource, scopes, expires_at from oauth_access_tokens limit 0`,
      );
      await this.db.execute(
        sql`select id, metric, version, snapshot from goals limit 0`,
      );
      await this.db.execute(
        sql`select goal_id, version, effective_on from goal_revisions limit 0`,
      );
      await this.db.execute(
        sql`select operation, idempotency_key, request_hash from goal_idempotency_requests limit 0`,
      );
      return true;
    } catch {
      return false;
    }
  }
  async execute(name: string, input: Data): Promise<Data> {
    const operation = operationByName.get(name);
    if (!operation)
      throw new DomainError("NOT_FOUND", "Unknown domain operation");
    if (operation.domain === "attachments")
      return this.attachments.execute(operation, input);
    if (operation.mutation) parse(idempotencyKey, input.idempotency_key);
    const command = operation.mutation
      ? input
      : (parse(operation.input, input) as Data);
    if (name === "health_get_catalog") return catalog(command, this.cursors);
    const timezone =
      name === "health_get_record" ? "UTC" : await accountTimezone(this.db);
    if (operation.domain === "goals")
      return new Goals(this.db, timezone).execute(operation, input);
    const store = new Store(this.db, timezone);
    const reads = new Reads(store, this.cursors);
    if (operation.mutation)
      return boundedResponse(await store.mutation(operation, input));
    switch (name) {
      case "health_list_records":
        return reads.list(command);
      case "health_get_record":
        return reads.record(command);
      case "health_get_daily_summary":
        return reads.daily(command);
      case "health_get_context":
        return reads.context(command);
      case "health_get_trends":
        return reads.trends(command);
      default:
        throw new DomainError("NOT_FOUND", "Unknown read operation");
    }
  }
}
