import type { RecordType } from "../registry/definitions.js";
export type Data = Record<string, unknown>;
export type Provenance = {
  source_type: "manual" | "device" | "laboratory" | "calculated" | "other";
  value_kind: "measured" | "reported" | "estimated" | "calculated";
  source_description?: string;
  source_locator?: string;
  assumptions?: string[];
  field_overrides?: Record<
    string,
    {
      validity?: "valid" | "suspect" | "invalid";
      reason?: string;
      value_kind?: string;
      source_type?: string;
      source_description?: string;
      uncertainty_note?: string;
    }
  >;
};
export type RecordInput = {
  occurred_on?: string | null;
  occurred_at?: string | null;
  ended_at?: string | null;
  timezone?: string;
  time_precision?: "date" | "instant" | "period" | "unknown";
  date_basis?:
    | "reported_date"
    | "event_date"
    | "wake_date"
    | "specimen_date"
    | "report_date"
    | "unknown";
  provenance: Provenance;
  validity?: "valid" | "suspect" | "invalid";
  data: Data;
};
export type HealthRecord = {
  id: string;
  record_type: RecordType;
  schema_version: number;
  version: number;
  occurred_on: string | null;
  occurred_at: string | null;
  ended_at: string | null;
  timezone: string;
  time_precision: string;
  date_basis: string;
  recorded_at: string;
  updated_at: string;
  status: "active" | "voided";
  validity: "valid" | "suspect" | "invalid";
  provenance: Provenance;
  data: Data;
  time_context: {
    original_occurred_at: string | null;
    original_ended_at: string | null;
    supplied_timezone: string | null;
  };
};
export function object(value: unknown): Data {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : {};
}
export function at(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const part of path
    .split("/")
    .slice(1)
    .map((key) => key.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(part)) return undefined;
      current = current[Number(part)];
    } else current = object(current)[part];
  }
  return current;
}
export function usable(
  record: HealthRecord,
  path?: string,
  includePreliminary = false,
): boolean {
  if (record.status !== "active" || record.validity !== "valid") return false;
  if (
    record.data.source_status === "cancelled" ||
    (!includePreliminary && record.data.source_status === "preliminary")
  )
    return false;
  if (path) {
    for (const [field, override] of Object.entries(
      record.provenance.field_overrides ?? {},
    )) {
      if (
        (field === path || path.startsWith(field + "/")) &&
        override.validity &&
        override.validity !== "valid"
      )
        return false;
    }
    if (path.startsWith("/components/")) {
      const component = object(
        at(record.data, path.split("/").slice(0, 3).join("/")),
      );
      if (
        (component.validity && component.validity !== "valid") ||
        (object(component.provenance).validity &&
          object(component.provenance).validity !== "valid")
      )
        return false;
    }
  }
  return true;
}
export function valueKindAt(record: HealthRecord, path: string): string {
  let kind = record.provenance.value_kind as string;
  const overrides = Object.entries(record.provenance.field_overrides ?? {})
    .filter(([field]) => field === path || path.startsWith(field + "/"))
    .sort(([a], [b]) => a.length - b.length);
  for (const [, override] of overrides)
    if (override.value_kind) kind = override.value_kind;
  return kind;
}
