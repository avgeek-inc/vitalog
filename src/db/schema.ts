import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { Data, HealthRecord, Provenance } from "../domain/types.js";
import { recordTypes } from "../registry/definitions.js";

export const healthRecords = pgTable(
  "health_records",
  {
    id: uuid("id").primaryKey(),
    recordType: text("record_type", { enum: recordTypes }).notNull(),
    schemaVersion: integer("schema_version").notNull(),
    version: integer("version").notNull(),
    occurredOn: date("occurred_on", { mode: "string" }),
    occurredAt: timestamp("occurred_at", {
      withTimezone: true,
      mode: "string",
    }),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "string" }),
    timezone: text("timezone").notNull(),
    timePrecision: text("time_precision").notNull(),
    dateBasis: text("date_basis").notNull(),
    recordedAt: timestamp("recorded_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    status: text("status", { enum: ["active", "voided"] }).notNull(),
    validity: text("validity", {
      enum: ["valid", "suspect", "invalid"],
    }).notNull(),
    provenance: jsonb("provenance").$type<Provenance>().notNull(),
    payload: jsonb("payload").$type<Data>().notNull(),
    timeContext: jsonb("time_context")
      .$type<HealthRecord["time_context"]>()
      .notNull()
      .default({
        original_occurred_at: null,
        original_ended_at: null,
        supplied_timezone: null,
      }),
  },
  (t) => [
    check(
      "valid_record_type",
      sql`${t.recordType} in ('measurement','nutrition','hydration','activity','sleep','checkin','intake','lab_result')`,
    ),
    check("positive_version", sql`${t.version} > 0 and ${t.schemaVersion} > 0`),
    check("valid_status", sql`${t.status} in ('active','voided')`),
    check("valid_quality", sql`${t.validity} in ('valid','suspect','invalid')`),
    check(
      "dated_non_lab",
      sql`${t.recordType} = 'lab_result' or ${t.occurredOn} is not null`,
    ),
    index("record_history_order").on(t.occurredOn, t.recordedAt, t.id),
    index("type_date").on(t.recordType, t.occurredOn),
    index("source_type").on(sql`(${t.provenance}->>'source_type')`),
    index("metric_key").on(sql`(${t.payload}->>'metric_key')`),
    index("analyte_key").on(sql`(${t.payload}->>'analyte_key')`),
    uniqueIndex("one_active_daily_total")
      .on(t.recordType, t.occurredOn)
      .where(
        sql`${t.status} = 'active' and ${t.payload}->>'entry_kind' = 'daily_total' and ${t.recordType} in ('nutrition','hydration','activity')`,
      ),
  ],
);
export const revisions = pgTable(
  "record_revisions",
  {
    recordId: uuid("record_id")
      .notNull()
      .references(() => healthRecords.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    snapshot: jsonb("snapshot").$type<HealthRecord>().notNull(),
    changedAt: timestamp("changed_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    reason: text("reason").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.recordId, t.version] }),
    check("revision_positive", sql`${t.version} > 0`),
  ],
);
export type MutationMetadata = {
  ids: string[];
  versions: number[];
  warnings: string[];
  batch: boolean;
};
export const idempotencyRequests = pgTable(
  "idempotency_requests",
  {
    operation: text("operation").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    resultMetadata: jsonb("result_metadata")
      .$type<MutationMetadata>()
      .notNull(),
    committedAt: timestamp("committed_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.operation, t.idempotencyKey] })],
);
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    tokenDigest: text("token_digest").notNull(),
    tokenHint: text("token_hint").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`statement_timestamp()`),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`statement_timestamp() + interval '720 hours'`),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("api_key_digest").on(t.tokenDigest),
    index("api_key_creation_order").on(t.createdAt, t.id),
    check(
      "api_key_lifetime",
      sql`${t.expiresAt} = ${t.createdAt} + interval '720 hours'`,
    ),
    check("api_key_name", sql`length(${t.name}) between 1 and 80`),
    check("api_key_sha256", sql`${t.tokenDigest} ~ '^[0-9a-f]{64}$'`),
  ],
);
export const schema = {
  healthRecords,
  revisions,
  idempotencyRequests,
  apiKeys,
};
