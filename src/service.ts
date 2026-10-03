import { sql } from "drizzle-orm";
import type { Database } from "./db/client.js";
import { parse, DomainError } from "./errors.js";
import { catalog, boundedResponse } from "./domain/catalog.js";
import { Cursors } from "./domain/cursor.js";
import { Reads } from "./domain/reads.js";
import { Store } from "./domain/store.js";
import type { Data } from "./domain/types.js";
import { operationByName } from "./registry/operations.js";

export class Service {
  private store: Store;
  private reads: Reads;
  private cursors: Cursors;
  constructor(
    public db: Database,
    timezone: string,
    cursorKey: string,
  ) {
    this.store = new Store(db, timezone);
    this.cursors = new Cursors(cursorKey);
    this.reads = new Reads(this.store, this.cursors);
  }
  async ready(): Promise<boolean> {
    try {
      await this.db.execute(
        sql`select id, time_context from health_records limit 0`,
      );
      await this.db.execute(
        sql`select id, token_digest, expires_at, revoked_at from api_keys limit 0`,
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
    if (operation.mutation)
      return boundedResponse(await this.store.mutation(operation, input));
    const command = parse(operation.input, input) as Data;
    switch (name) {
      case "health_get_catalog":
        return catalog(command, this.cursors);
      case "health_list_records":
        return this.reads.list(command);
      case "health_get_record":
        return this.reads.record(command);
      case "health_get_daily_summary":
        return this.reads.daily(command);
      case "health_get_context":
        return this.reads.context(command);
      case "health_get_trends":
        return this.reads.trends(command);
      default:
        throw new DomainError("NOT_FOUND", "Unknown read operation");
    }
  }
}
