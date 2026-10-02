import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database, Transaction } from "../db/client.js";
import {
  healthRecords,
  idempotencyRequests,
  revisions,
  type MutationMetadata,
} from "../db/schema.js";
import { DomainError, fail, parse } from "../errors.js";
import {
  CATALOG_VERSION,
  RECORD_SCHEMA_VERSION,
} from "../registry/definitions.js";
import { idempotencyKey, type Operation } from "../registry/operations.js";
import { hash } from "./canonical.js";
import { normalizeInput, readStoredSnapshot } from "./validation.js";
import { object, type Data, type HealthRecord } from "./types.js";

export function fromRow(row: typeof healthRecords.$inferSelect): HealthRecord {
  return {
    id: row.id,
    record_type: row.recordType,
    schema_version: row.schemaVersion,
    version: row.version,
    occurred_on: row.occurredOn,
    occurred_at: row.occurredAt ? new Date(row.occurredAt).toISOString() : null,
    ended_at: row.endedAt ? new Date(row.endedAt).toISOString() : null,
    timezone: row.timezone,
    time_precision: row.timePrecision,
    date_basis: row.dateBasis,
    recorded_at: new Date(row.recordedAt).toISOString(),
    updated_at: new Date(row.updatedAt).toISOString(),
    status: row.status,
    validity: row.validity,
    provenance: row.provenance,
    data: readStoredSnapshot(row.payload, row.schemaVersion),
    time_context: row.timeContext,
  };
}
function toRow(record: HealthRecord): typeof healthRecords.$inferInsert {
  return {
    id: record.id,
    recordType: record.record_type,
    schemaVersion: record.schema_version,
    version: record.version,
    occurredOn: record.occurred_on,
    occurredAt: record.occurred_at,
    endedAt: record.ended_at,
    timezone: record.timezone,
    timePrecision: record.time_precision,
    dateBasis: record.date_basis,
    recordedAt: record.recorded_at,
    updatedAt: record.updated_at,
    status: record.status,
    validity: record.validity,
    provenance: record.provenance,
    payload: record.data,
    timeContext: record.time_context,
  };
}
export const WRITE_LOCK = sql`select pg_advisory_xact_lock(84309212)`;

export class Store {
  constructor(
    public db: Database,
    public defaultTimezone: string,
  ) {}
  async mutation(operation: Operation, raw: Data): Promise<Data> {
    const key = parse(idempotencyKey, raw.idempotency_key);
    const { idempotency_key: _key, ...domain } = raw;
    const digest = hash(domain);
    try {
      return await this.db.transaction(async (tx) => {
        await tx.execute(WRITE_LOCK);
        const [committed] = await tx
          .select()
          .from(idempotencyRequests)
          .where(
            and(
              eq(idempotencyRequests.operation, operation.name),
              eq(idempotencyRequests.idempotencyKey, key),
            ),
          );
        if (committed) {
          if (committed.requestHash !== digest)
            throw new DomainError(
              "IDEMPOTENCY_CONFLICT",
              "This key already committed a different request",
            );
          return this.result(tx, committed.resultMetadata, true);
        }
        const command = parse(operation.input, raw) as Data;
        let records: HealthRecord[];
        let warnings: string[] = [];
        const now = new Date();
        if (operation.record_type) {
          const type = operation.record_type;
          const entries = operation.batch
            ? (command.records as Data[])
            : [domain];
          const shared = object(command.shared_metadata);
          records = [];
          for (const entry of entries) {
            const {
              laboratory,
              report_reference,
              report_revision,
              specimen,
              specimen_reference,
              collected_on,
              collected_at,
              reported_on,
              reported_at,
              method,
              source_status,
              original_panel_label,
              ...envelope
            } = shared;
            const sharedData = Object.fromEntries(
              Object.entries({
                laboratory,
                report_reference,
                report_revision,
                specimen,
                specimen_reference,
                collected_on,
                collected_at,
                reported_on,
                reported_at,
                method,
                source_status,
                original_panel_label,
              }).filter(([, value]) => value !== undefined),
            );
            const input = {
              ...envelope,
              ...entry,
              data: { ...sharedData, ...object(entry.data) },
            };
            const normalized = normalizeInput(
              type,
              input,
              this.defaultTimezone,
              now,
            );
            warnings.push(...normalized.warnings);
            const { warnings: _warnings, ...fields } = normalized;
            const record: HealthRecord = {
              ...fields,
              id: randomUUID(),
              record_type: type,
              schema_version: RECORD_SCHEMA_VERSION,
              version: 1,
              recorded_at: now.toISOString(),
              updated_at: now.toISOString(),
              status: "active",
            };
            await this.checkDailyTotal(tx, record);
            await this.checkReferences(tx, record);
            if (type === "nutrition" && record.data.entry_kind === "intake") {
              const existing = await tx
                .select({ id: healthRecords.id })
                .from(healthRecords)
                .where(
                  and(
                    eq(healthRecords.recordType, type),
                    eq(healthRecords.occurredOn, record.occurred_on!),
                    eq(healthRecords.status, "active"),
                    sql`${healthRecords.payload}->>'entry_kind' = 'daily_total'`,
                  ),
                )
                .limit(1);
              if (existing.length) warnings.push("daily_total_present");
            }
            await tx.insert(healthRecords).values(toRow(record));
            await tx.insert(revisions).values({
              recordId: record.id,
              version: 1,
              snapshot: record,
              changedAt: now.toISOString(),
              reason: "created",
            });
            records.push(record);
          }
        } else {
          const [row] = await tx
            .select()
            .from(healthRecords)
            .where(eq(healthRecords.id, String(command.id)))
            .for("update");
          if (!row) throw new DomainError("NOT_FOUND", "Record does not exist");
          const previous = fromRow(row);
          if (previous.version !== command.expected_version)
            throw new DomainError(
              "VERSION_CONFLICT",
              "The record changed; retrieve its current version",
              [],
              { current_version: previous.version },
            );
          let record = {
            ...previous,
            version: previous.version + 1,
            updated_at: now.toISOString(),
          };
          if (operation.name === "health_void_record") record.status = "voided";
          else {
            const { record_type, ...replacement } = object(command.replacement);
            if (record_type !== previous.record_type)
              fail(
                "/replacement/record_type",
                "A correction cannot change record type",
              );
            const normalized = normalizeInput(
              previous.record_type,
              replacement,
              previous.timezone,
              now,
            );
            const { warnings: replacementWarnings, ...fields } = normalized;
            warnings = replacementWarnings;
            record = {
              ...record,
              ...fields,
              schema_version: RECORD_SCHEMA_VERSION,
            };
            await this.checkDailyTotal(tx, record);
            await this.checkReferences(tx, record);
          }
          await tx
            .update(healthRecords)
            .set(toRow(record))
            .where(eq(healthRecords.id, record.id));
          await tx.insert(revisions).values({
            recordId: record.id,
            version: record.version,
            snapshot: record,
            changedAt: now.toISOString(),
            reason: String(command.reason),
          });
          records = [record];
        }
        const metadata: MutationMetadata = {
          ids: records.map((record) => record.id),
          versions: records.map((record) => record.version),
          warnings: [...new Set(warnings)],
          batch: !!operation.batch,
        };
        await tx.insert(idempotencyRequests).values({
          operation: operation.name,
          idempotencyKey: key,
          requestHash: digest,
          resultMetadata: metadata,
          committedAt: now.toISOString(),
        });
        return this.result(tx, metadata, false);
      });
    } catch (error) {
      const cause = object(object(error).cause);
      if (
        cause.code === "23505" &&
        cause.constraint === "one_active_daily_total"
      )
        throw new DomainError(
          "DAILY_TOTAL_EXISTS",
          "An active daily total already exists for this date",
        );
      throw error;
    }
  }
  private async result(
    tx: Transaction,
    metadata: MutationMetadata,
    replay: boolean,
  ): Promise<Data> {
    const records: HealthRecord[] = [];
    for (const [index, id] of metadata.ids.entries()) {
      const [revision] = await tx
        .select()
        .from(revisions)
        .where(
          and(
            eq(revisions.recordId, id),
            eq(revisions.version, metadata.versions[index]!),
          ),
        );
      if (!revision)
        throw new DomainError(
          "INTERNAL_ERROR",
          "Committed revision could not be retrieved",
        );
      records.push(revision.snapshot);
    }
    return metadata.batch
      ? {
          catalog_version: CATALOG_VERSION,
          records,
          warnings: metadata.warnings,
          idempotent_replay: replay,
          committed_versions: metadata.versions,
        }
      : {
          catalog_version: CATALOG_VERSION,
          record: records[0],
          warnings: metadata.warnings,
          idempotent_replay: replay,
          committed_version: metadata.versions[0],
        };
  }
  private async checkDailyTotal(
    tx: Transaction,
    record: HealthRecord,
  ): Promise<void> {
    if (
      record.status !== "active" ||
      record.data.entry_kind !== "daily_total" ||
      !["nutrition", "hydration", "activity"].includes(record.record_type)
    )
      return;
    const [existing] = await tx
      .select({ id: healthRecords.id })
      .from(healthRecords)
      .where(
        and(
          eq(healthRecords.recordType, record.record_type),
          eq(healthRecords.occurredOn, record.occurred_on!),
          eq(healthRecords.status, "active"),
          sql`${healthRecords.payload}->>'entry_kind' = 'daily_total'`,
          sql`${healthRecords.id} <> ${record.id}`,
        ),
      )
      .limit(1);
    if (existing)
      throw new DomainError(
        "DAILY_TOTAL_EXISTS",
        "Correct the existing daily total instead of creating another",
        [],
        { existing_id: existing.id },
      );
  }
  private async checkReferences(
    tx: Transaction,
    record: HealthRecord,
  ): Promise<void> {
    const links =
      (record.data.related_record_ids as
        { record_id: string; relationship: string }[] | undefined) ?? [];
    const otherIds = [
      ...((record.data.related_result_ids as string[] | undefined) ?? []),
      ...((object(record.data.quantity_context).calculation_inputs as
        string[] | undefined) ?? []),
    ];
    const pregnancy = object(record.data.reproductive).pregnancy_test_record_id;
    if (typeof pregnancy === "string") otherIds.push(pregnancy);
    for (const id of [...links.map((link) => link.record_id), ...otherIds]) {
      if (id === record.id)
        fail("/data/related_record_ids", "A record cannot reference itself");
      const [existing] = await tx
        .select({ id: healthRecords.id })
        .from(healthRecords)
        .where(eq(healthRecords.id, id));
      if (!existing)
        fail(
          "/data/related_record_ids",
          "Related record does not exist",
          "not_found",
        );
    }
    for (const link of links.filter((item) =>
      ["component_of", "derived_from"].includes(item.relationship),
    )) {
      const visited = new Set<string>();
      const pending = [link.record_id];
      while (pending.length) {
        const id = pending.pop()!;
        if (id === record.id)
          fail(
            "/data/related_record_ids",
            "Hierarchical relationship would create a cycle",
          );
        if (visited.has(id)) continue;
        visited.add(id);
        if (visited.size > 1000)
          throw new DomainError(
            "LIMIT_EXCEEDED",
            "Relationship graph exceeds the verification bound",
          );
        const [row] = await tx
          .select({ data: healthRecords.payload })
          .from(healthRecords)
          .where(eq(healthRecords.id, id));
        for (const parent of (row?.data.related_record_ids as
          typeof links | undefined) ?? [])
          if (["component_of", "derived_from"].includes(parent.relationship))
            pending.push(parent.record_id);
      }
    }
  }
}
