import { z } from "zod";
import {
  CATALOG_VERSION,
  analyteKeys,
  measurementKeys,
  nutrientKeys,
} from "./registry/definitions.js";

export const errorStatuses = {
  VALIDATION_ERROR: 422,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  DAILY_TOTAL_EXISTS: 409,
  CATALOG_VERSION_MISMATCH: 409,
  LIMIT_EXCEEDED: 413,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  UNAVAILABLE: 503,
  TIMEOUT: 408,
  INTERNAL_ERROR: 500,
} as const;
export type ErrorCode = keyof typeof errorStatuses;
export type Issue = {
  path: string;
  reason: string;
  message?: string;
  suggested_keys?: string[];
  discovery?: {
    tool: string;
    arguments: Record<string, string>;
    rest_path: string;
  };
};
export class DomainError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public issues: Issue[] = [],
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DomainError";
  }
  get status() {
    return errorStatuses[this.code];
  }
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      catalog_version: CATALOG_VERSION,
      issues: this.issues,
      ...this.details,
    };
  }
}
export function fail(
  path: string,
  message: string,
  reason = "cross_field_conflict",
): never {
  throw new DomainError("VALIDATION_ERROR", "Input failed validation", [
    { path, reason, message },
  ]);
}
export const pointerEscape = (part: string | number) =>
  String(part).replaceAll("~", "~0").replaceAll("/", "~1");
function suppliedAt(value: unknown, path: PropertyKey[]): unknown {
  return path.reduce<unknown>((current, part) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<PropertyKey, unknown>)[part];
  }, value);
}
function catalogDiscriminatorIssues(
  issues: z.core.$ZodIssue[],
  value: unknown,
  parent: PropertyKey[] = [],
): z.core.$ZodIssue[] {
  return issues.flatMap((issue) => {
    const path = [...parent, ...issue.path];
    const key = path.at(-1);
    const known =
      key === "metric_key"
        ? measurementKeys
        : key === "analyte_key"
          ? analyteKeys
          : undefined;
    const supplied = suppliedAt(value, path);
    if (known && typeof supplied === "string" && !known.includes(supplied))
      return [{ ...issue, path }];
    return issue.code === "invalid_union"
      ? catalogDiscriminatorIssues(issue.errors.flat(), value, path)
      : [];
  });
}
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const actionable = result.error.issues.flatMap((issue) => {
    if (issue.code !== "invalid_union") return [issue];
    const nested = catalogDiscriminatorIssues([issue], value);
    return nested.length ? nested : [issue];
  });
  const issues: Issue[] = actionable.flatMap((issue) => {
    const path = issue.path.length
      ? "/" + issue.path.map((part) => pointerEscape(String(part))).join("/")
      : "";
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) =>
        validationIssue(`${path}/${pointerEscape(key)}`, "unknown_field", key),
      );
    }
    if (["analyte_key", "metric_key"].includes(String(issue.path.at(-1)))) {
      const supplied = suppliedAt(value, issue.path);
      return [
        validationIssue(
          path,
          issue.path.at(-1) === "analyte_key"
            ? "unknown_builtin_analyte"
            : "unknown_measurement",
          typeof supplied === "string" ? supplied : "",
        ),
      ];
    }
    return [{ path, reason: issue.code, message: issue.message.slice(0, 300) }];
  });
  throw new DomainError(
    "VALIDATION_ERROR",
    "Input failed validation",
    [
      ...new Map(
        issues.map((issue) => [JSON.stringify(issue), issue]),
      ).values(),
    ].slice(0, 30),
  );
}
function validationIssue(path: string, reason: string, key: string): Issue {
  const category = path.endsWith("/analyte_key")
    ? "lab_analytes"
    : path.endsWith("/metric_key")
      ? "measurements"
      : /\/(nutrients|supplement_nutrients|nutrient_qualifiers|component_details)\//.test(
            path,
          )
        ? "nutrients"
        : "record_schemas";
  const known =
    category === "nutrients"
      ? nutrientKeys
      : category === "lab_analytes"
        ? analyteKeys
        : category === "measurements"
          ? measurementKeys
          : [];
  const suggestions = known
    .filter((candidate) => candidate === key || candidate.startsWith(key + "_"))
    .slice(0, 3);
  const lookup = suggestions[0];
  return {
    path,
    reason,
    suggested_keys: suggestions,
    discovery: {
      tool: "health_get_catalog",
      arguments: lookup ? { category, key: lookup } : { category },
      rest_path: `/v1/catalog?category=${category}${lookup ? `&key=${encodeURIComponent(lookup)}` : ""}`,
    },
  };
}
export function publicError(error: unknown): DomainError {
  return error instanceof DomainError
    ? error
    : new DomainError("INTERNAL_ERROR", "The operation could not be completed");
}
