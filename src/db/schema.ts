import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
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
import type { ClientMetadata } from "../auth/oauth-clients.js";
import { recordTypes } from "../registry/definitions.js";
import type { Goal } from "../registry/goals.js";
import {
  MAX_ATTACHMENT_BYTES,
  type Attachment,
} from "../registry/attachments.js";
import type { StorageLocation } from "../attachments/storage.js";

export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey(),
    filename: text("filename").notNull(),
    contentType: text("content_type")
      .$type<Attachment["content_type"]>()
      .notNull(),
    byteLength: integer("byte_length").notNull(),
    sha256: text("sha256").notNull(),
    status: text("status", { enum: ["pending", "ready", "expired"] }).notNull(),
    storage: jsonb("storage").$type<StorageLocation>().notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    uploadExpiresAt: timestamp("upload_expires_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    readyAt: timestamp("ready_at", { withTimezone: true, mode: "string" }),
    uploadPrunedAt: timestamp("upload_pruned_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (t) => [
    check(
      "attachment_size",
      sql`${t.byteLength} > 0 and ${t.byteLength} <= ${sql.raw(String(MAX_ATTACHMENT_BYTES))}`,
    ),
    check("attachment_sha256", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check(
      "attachment_state",
      sql`(${t.status} = 'ready' and ${t.readyAt} is not null) or (${t.status} in ('pending', 'expired') and ${t.readyAt} is null)`,
    ),
    check(
      "attachment_lifetime",
      sql`${t.uploadExpiresAt} = ${t.createdAt} + interval '15 minutes'`,
    ),
    index("attachment_creation_order").on(t.createdAt, t.id),
    index("attachment_status_expiry").on(t.status, t.uploadExpiresAt),
  ],
);

export const attachmentIdempotency = pgTable(
  "attachment_idempotency_requests",
  {
    operation: text("operation").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    attachmentId: uuid("attachment_id")
      .notNull()
      .references(() => attachments.id),
    snapshot: jsonb("snapshot").$type<Attachment>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.operation, t.idempotencyKey] })],
);

export const goals = pgTable(
  "goals",
  {
    id: uuid("id").primaryKey(),
    metric: text("metric").notNull(),
    version: integer("version").notNull(),
    snapshot: jsonb("snapshot").$type<Goal>().notNull(),
  },
  (t) => [
    uniqueIndex("one_goal_per_metric").on(t.metric),
    check("goal_positive_version", sql`${t.version} > 0`),
    check(
      "goal_snapshot_identity",
      sql`${t.snapshot}->>'id' = ${t.id}::text and ${t.snapshot}->>'metric' = ${t.metric} and (${t.snapshot}->>'version')::integer = ${t.version}`,
    ),
  ],
);
export const goalRevisions = pgTable(
  "goal_revisions",
  {
    goalId: uuid("goal_id")
      .notNull()
      .references(() => goals.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    effectiveOn: date("effective_on", { mode: "string" }).notNull(),
    snapshot: jsonb("snapshot").$type<Goal>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.goalId, t.version] }),
    index("goal_effective_date").on(t.effectiveOn, t.goalId, t.version),
  ],
);
export const goalIdempotency = pgTable(
  "goal_idempotency_requests",
  {
    operation: text("operation").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    snapshot: jsonb("snapshot").$type<Goal>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.operation, t.idempotencyKey] })],
);

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
    attachmentIds: uuid("attachment_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
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
export const recordAttachments = pgTable(
  "record_attachments",
  {
    recordId: uuid("record_id").notNull(),
    recordVersion: integer("record_version").notNull(),
    attachmentId: uuid("attachment_id")
      .notNull()
      .references(() => attachments.id),
  },
  (t) => [
    primaryKey({ columns: [t.recordId, t.recordVersion, t.attachmentId] }),
    foreignKey({
      columns: [t.recordId, t.recordVersion],
      foreignColumns: [revisions.recordId, revisions.version],
    }).onDelete("cascade"),
    index("attachment_record_references").on(
      t.attachmentId,
      t.recordId,
      t.recordVersion,
    ),
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
    tokenDigest: text("token_digest").notNull(),
    tokenHint: text("token_hint").notNull(),
    oauthClientId: text("oauth_client_id"),
    oauthClientName: text("oauth_client_name"),
    oauthScopes: text("oauth_scopes").array(),
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
      sql`${t.expiresAt} = ${t.createdAt} + case when left(${t.tokenHint}, 4) = 'vlm_' then interval '30 minutes' else interval '720 hours' end`,
    ),
    check("api_key_sha256", sql`${t.tokenDigest} ~ '^[0-9a-f]{64}$'`),
  ],
);
export const oauthCodes = pgTable(
  "oauth_authorization_codes",
  {
    codeDigest: text("code_digest").primaryKey(),
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, {
      onDelete: "cascade",
    }),
    clientName: text("client_name"),
    clientId: text("client_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    resource: text("resource").notNull(),
    scopes: text("scopes").array().notNull(),
    codeChallenge: text("code_challenge").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`statement_timestamp()`),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`statement_timestamp() + interval '300 seconds'`),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => [
    index("oauth_code_expiry").on(t.expiresAt),
    check("oauth_code_sha256", sql`${t.codeDigest} ~ '^[0-9a-f]{64}$'`),
    check("oauth_code_pkce", sql`${t.codeChallenge} ~ '^[A-Za-z0-9_-]{43}$'`),
    check(
      "oauth_code_lifetime",
      sql`${t.expiresAt} = ${t.createdAt} + interval '300 seconds'`,
    ),
    check(
      "oauth_code_scopes",
      sql`cardinality(${t.scopes}) > 0 and ${t.scopes} <@ array['health:read', 'health:write']::text[]`,
    ),
  ],
);
export const oauthTokens = pgTable(
  "oauth_access_tokens",
  {
    tokenDigest: text("token_digest").primaryKey(),
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    resource: text("resource").notNull(),
    scopes: text("scopes").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`statement_timestamp()`),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("oauth_token_expiry").on(t.expiresAt),
    index("oauth_token_key").on(t.apiKeyId),
    check("oauth_token_sha256", sql`${t.tokenDigest} ~ '^[0-9a-f]{64}$'`),
    check(
      "oauth_token_lifetime",
      sql`${t.expiresAt} > ${t.createdAt} and ${t.expiresAt} <= ${t.createdAt} + interval '720 hours'`,
    ),
    check(
      "oauth_token_scopes",
      sql`cardinality(${t.scopes}) > 0 and (${t.scopes} <@ array['health:read', 'health:write']::text[] or (${t.resource} = 'urn:vitalog:key-management' and ${t.scopes} = array['keys:manage']::text[]))`,
    ),
  ],
);
export const oauthClients = pgTable(
  "oauth_clients",
  {
    clientId: text("client_id").primaryKey(),
    metadata: jsonb("metadata").$type<ClientMetadata>().notNull(),
    clientSecretDigest: text("client_secret_digest"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`statement_timestamp()`),
  },
  (t) => [
    check("oauth_client_id", sql`${t.clientId} ~ '^vcl_[A-Za-z0-9_-]{43}$'`),
    check(
      "oauth_client_secret_sha256",
      sql`${t.clientSecretDigest} is null or ${t.clientSecretDigest} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);
export const oauthClientAssertions = pgTable(
  "oauth_client_assertions",
  {
    assertionDigest: text("assertion_digest").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("oauth_client_assertion_expiry").on(t.expiresAt),
    check(
      "oauth_client_assertion_sha256",
      sql`${t.assertionDigest} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);
export const schema = {
  attachments,
  attachmentIdempotency,
  recordAttachments,
  goals,
  goalRevisions,
  goalIdempotency,
  healthRecords,
  revisions,
  idempotencyRequests,
  apiKeys,
  oauthCodes,
  oauthTokens,
  oauthClients,
  oauthClientAssertions,
};

export const accountSettings = pgTable(
  "account_settings",
  {
    id: integer("id").primaryKey(),
    name: text("name").notNull(),
    dateFormat: text("date_format").notNull().default("day-short-month-year"),
    timeFormat: text("time_format").notNull().default("24-hour"),
    timeZone: text("time_zone").notNull().default("UTC"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("account_settings_singleton", sql`${table.id} = 1`),
    check(
      "account_name_length",
      sql`length(btrim(${table.name})) between 1 and 120`,
    ),
    check(
      "account_date_format",
      sql`${table.dateFormat} in ('day-short-month-year', 'short-month-day-year', 'year-month-day', 'day-month-year', 'month-day-year')`,
    ),
    check(
      "account_time_format",
      sql`${table.timeFormat} in ('24-hour', '12-hour', '24-hour-seconds', '12-hour-seconds')`,
    ),
    check(
      "account_time_zone_length",
      sql`length(${table.timeZone}) between 1 and 100`,
    ),
  ],
);
