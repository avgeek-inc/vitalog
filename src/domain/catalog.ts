import { DomainError, fail, pointerEscape } from "../errors.js";
import {
  CATALOG_VERSION,
  inventory,
  label,
  labDefinitions,
  measurementDefinitions,
  nutrientDefinitions,
  recordTypes,
  resultSchemaForLab,
  type RecordType,
} from "../registry/definitions.js";
import { catalogInput, operations, restBody } from "../registry/operations.js";
import { jsonSchema } from "../registry/primitives.js";
import { recordSchemas } from "../registry/records.js";
import { validationRules } from "./validation.js";
import { Cursors } from "./cursor.js";
import { object, type Data } from "./types.js";

export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export function boundedResponse<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_RESPONSE_BYTES)
    throw new DomainError(
      "LIMIT_EXCEEDED",
      "Response exceeds the byte limit; narrow the query or request a field path",
    );
  return value;
}
function resolveRef(schema: Data, root: Data): Data {
  if (typeof schema.$ref !== "string") return schema;
  const target = schema.$ref
    .split("/")
    .slice(1)
    .reduce<unknown>(
      (value, key) =>
        object(value)[key.replaceAll("~1", "/").replaceAll("~0", "~")],
      root,
    );
  return resolveRef(object(target), root);
}
const alternatives = (node: Data) => (node.anyOf ?? node.oneOf ?? []) as Data[];
function selfContained(node: Data, root: Data): Data {
  const definitions: Data = {};
  function scan(value: unknown) {
    if (Array.isArray(value)) {
      value.forEach(scan);
      return;
    }
    if (!value || typeof value !== "object") return;
    const entry = object(value);
    if (typeof entry.$ref === "string" && entry.$ref.startsWith("#/$defs/")) {
      const key = entry.$ref.slice(8);
      if (!(key in definitions)) {
        definitions[key] = object(root.$defs)[key];
        scan(definitions[key]);
      }
    }
    Object.values(entry).forEach(scan);
  }
  scan(node);
  return {
    ...node,
    ...(Object.keys(definitions).length ? { $defs: definitions } : {}),
  };
}
function schemaAt(schema: Data, path: string): Data {
  let nodes = [schema];
  for (const key of path
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    const next: Data[] = [];
    const expand = (node: Data) => {
      node = resolveRef(node, schema);
      alternatives(node).forEach(expand);
      if (object(node.properties)[key])
        next.push(object(object(node.properties)[key]));
      if (
        node.type === "array" &&
        /^(?:0|[1-9]\d*)$/.test(key) &&
        Number(key) < Number(node.maxItems ?? Infinity)
      )
        next.push(object(node.items));
    };
    nodes.forEach(expand);
    if (!next.length)
      throw new DomainError("NOT_FOUND", "Unknown writable field path");
    nodes = next;
  }
  const entries = nodes.map((node) => resolveRef(node, schema));
  return {
    ...selfContained(
      entries.length === 1 ? entries[0]! : { anyOf: entries },
      schema,
    ),
    $schema: "https://json-schema.org/draft/2020-12/schema",
  };
}
export function fieldIndex(type: RecordType): Data[] {
  const schema = jsonSchema(recordSchemas[type]) as Data;
  const fields = new Map<string, Data>();
  function visit(
    raw: Data,
    path: string,
    required: boolean,
    variants: string[],
  ) {
    const node = resolveRef(raw, schema);
    const existing = fields.get(path);
    if (path && existing) {
      existing.applicable_variants = [
        ...new Set([
          ...(existing.applicable_variants as string[]),
          ...variants,
        ]),
      ];
      const previousSchema = object(existing.field_schema);
      const { $defs: previousDefinitions, ...previousBody } = previousSchema;
      const nextSchema = selfContained(node, schema);
      const { $defs: nextDefinitions, ...nextBody } = nextSchema;
      if (JSON.stringify(previousBody) !== JSON.stringify(nextBody))
        existing.field_schema = {
          anyOf: [previousBody, nextBody],
          ...(previousDefinitions || nextDefinitions
            ? {
                $defs: {
                  ...object(previousDefinitions),
                  ...object(nextDefinitions),
                },
              }
            : {}),
        };
      if (required) (existing.required_conditions as string[][]).push(variants);
    }
    if (path && !fields.has(path))
      fields.set(path, {
        key: path.split("/").at(-1),
        label: label(path.split("/").at(-1)!),
        record_type: type,
        field_path: path,
        parent_path: path.split("/").slice(0, -1).join("/"),
        required,
        nullable:
          node.type === "null" ||
          alternatives(node).some((item) => item.type === "null"),
        applicable_variants: variants,
        field_schema: selfContained(node, schema),
        path_template_convention:
          "{index} is an array index; {key} is one of map_keys. Writes and overrides require actual indexed JSON Pointers.",
        required_conditions: required ? [variants] : [],
        introduced_in: "1.0.0",
        deprecated: false,
      });
    const branches = alternatives(node);
    for (const branch of branches) {
      const resolved = resolveRef(branch, schema);
      const tag = Object.entries(object(resolved.properties)).find(
        ([, value]) => object(value).const !== undefined,
      );
      visit(
        branch,
        path,
        required,
        tag ? [...variants, `${tag[0]}=${object(tag[1]).const}`] : variants,
      );
    }
    if (node.type === "array")
      visit(object(node.items), `${path}/{index}`, true, variants);
    const properties = object(node.properties);
    const keys = Object.keys(properties);
    if (
      keys.length > 100 &&
      !path.endsWith("/nutrients") &&
      !path.endsWith("/nutrient_contributions")
    ) {
      const representative = properties[keys[0]!]!;
      visit(object(representative), `${path}/{key}`, false, variants);
      fields.get(`${path}/{key}`)!.map_keys = keys;
    } else
      for (const [key, value] of Object.entries(properties))
        visit(
          object(value),
          `${path}/${pointerEscape(key)}`,
          ((node.required as string[] | undefined) ?? []).includes(key),
          variants,
        );
  }
  visit(schema, "", true, []);
  return [...fields.values()];
}
const schemaCache = new Map<RecordType, Data>();
const analyteDescriptors = labDefinitions.map((entry) => ({
  ...entry,
  field_path: "/result",
  field_schema: jsonSchema(resultSchemaForLab(entry.key)),
}));
export function recordDescriptor(type: RecordType, full = false): Data {
  if (!schemaCache.has(type)) {
    const operation = operations.find((op) => op.record_type === type)!;
    schemaCache.set(type, {
      key: type,
      label: label(type),
      description: `Strict mutable ${type} fields with typed nested variants.`,
      record_type: type,
      record_schema_version: 2,
      writable_data_schema: jsonSchema(recordSchemas[type]),
      correction_data_schema: jsonSchema(recordSchemas[type]),
      logging_contracts: [
        {
          tool_name: operation.name,
          input_schema: jsonSchema(operation.input),
          output_schema: jsonSchema(operation.output),
          rest_method: "POST",
          rest_path: operation.path,
          request_schema: jsonSchema(restBody(operation)),
          response_schema: jsonSchema(operation.output),
          idempotency_header: { name: "Idempotency-Key", required: true },
        },
      ],
      field_index: fieldIndex(type),
      validation_rules: validationRules,
      introduced_in: "1.0.0",
      deprecated: false,
    });
  }
  const descriptor = schemaCache.get(type)!;
  if (full) return descriptor;
  const {
    writable_data_schema: _data,
    correction_data_schema: _correction,
    logging_contracts,
    ...metadata
  } = descriptor;
  return {
    ...metadata,
    logging_contracts: (logging_contracts as Data[]).map(
      ({ tool_name, rest_method, rest_path }) => ({
        tool_name,
        rest_method,
        rest_path,
      }),
    ),
  };
}

export function catalog(raw: Data, cursors: Cursors): Data {
  const input = catalogInput.parse(raw);
  const category = input.category ?? "overview";
  if (input.catalog_version && input.catalog_version !== CATALOG_VERSION)
    throw new DomainError(
      "CATALOG_VERSION_MISMATCH",
      "Restart discovery with the current catalog version",
      [],
      { current_catalog_version: CATALOG_VERSION },
    );
  if (category === "overview") {
    if (
      Object.keys(input).some(
        (key) => !["category", "catalog_version"].includes(key),
      )
    )
      fail("/category", "Overview accepts only category and catalog_version");
    return {
      catalog_version: CATALOG_VERSION,
      category,
      response_variant: "overview",
      categories: [
        "overview",
        "nutrients",
        "lab_panels",
        "lab_analytes",
        "measurements",
        "record_schemas",
      ],
      record_types: [...recordTypes],
      counts: {
        nutrients: nutrientDefinitions.length,
        lab_panels: inventory.lab_panels.length,
        lab_analytes: labDefinitions.length,
        measurements: measurementDefinitions.length,
        record_schemas: recordTypes.length,
      },
      panel_keys: inventory.lab_panels.map((panel) => panel.panel_key),
      nutrient_groups: Object.fromEntries(
        Object.entries(inventory.nutrient_groups).map(([key, members]) => [
          key,
          members.length,
        ]),
      ),
      measurement_groups: Object.fromEntries(
        Object.entries(inventory.measurement_groups).map(([key, members]) => [
          key,
          members.length,
        ]),
      ),
      custom_analyte_policy:
        "Typed custom results preserve supplied identity/context; they never create a catalog entry or implicitly join a builtin series.",
      discovery_examples: [
        { category: "lab_analytes", panel_key: "cbc" },
        { category: "record_schemas", key: "nutrition", include_schema: true },
      ],
      openapi_path: "/openapi.json",
      record_schema_path: "/v1/catalog?category=record_schemas",
    };
  }
  if (
    input.key &&
    (input.query !== undefined ||
      input.cursor !== undefined ||
      input.limit !== undefined)
  )
    fail("/key", "Exact key cannot be combined with query, cursor or limit");
  if (input.group_key && input.panel_key)
    fail("/group_key", "Group and panel filters cannot be combined");
  if (input.group_key && !["nutrients", "measurements"].includes(category))
    fail("/group_key", "Group applies to nutrients or measurements");
  if (input.panel_key && category !== "lab_analytes")
    fail("/panel_key", "Panel filter applies to lab_analytes");
  if (input.include_schema !== undefined && category !== "record_schemas")
    fail("/include_schema", "Schema option applies only to record_schemas");
  if (input.include_schema && !input.key)
    fail("/include_schema", "Full schema requires an exact record key");
  if (
    input.field_path &&
    (category !== "record_schemas" ||
      !input.key ||
      input.include_schema ||
      input.query ||
      input.cursor ||
      input.limit !== undefined)
  )
    fail(
      "/field_path",
      "Field lookup requires an exact record key and include_schema=false",
    );
  let entries: Data[];
  switch (category) {
    case "nutrients":
      entries = nutrientDefinitions;
      break;
    case "lab_analytes":
      entries = analyteDescriptors;
      break;
    case "measurements":
      entries = measurementDefinitions;
      break;
    case "lab_panels":
      entries = inventory.lab_panels.map((panel) => ({
        key: panel.panel_key,
        ...panel,
        label: label(panel.panel_key),
        description:
          "Discovery group; all members are optional supplied observations.",
        search_aliases: [],
        analyte_lookup: {
          category: "lab_analytes",
          panel_key: panel.panel_key,
        },
      }));
      break;
    case "record_schemas":
      entries = recordTypes.map((type) =>
        recordDescriptor(type, !!input.include_schema),
      );
      break;
    default:
      entries = [];
  }
  if (input.group_key) {
    const groups =
      category === "nutrients"
        ? inventory.nutrient_groups
        : inventory.measurement_groups;
    if (!(input.group_key in groups))
      throw new DomainError("NOT_FOUND", "Unknown discovery group");
    entries = entries.filter((entry) => entry.group_key === input.group_key);
  }
  if (input.panel_key) {
    if (
      !inventory.lab_panels.some((panel) => panel.panel_key === input.panel_key)
    )
      throw new DomainError("NOT_FOUND", "Unknown laboratory panel");
    entries = entries.filter((entry) =>
      (entry.panel_keys as string[]).includes(input.panel_key!),
    );
  }
  if (input.key) {
    entries = entries.filter((entry) => entry.key === input.key);
    if (!entries.length)
      throw new DomainError(
        "NOT_FOUND",
        "Unknown catalog key in the selected scope",
      );
    if (input.field_path) {
      const type = input.key as RecordType;
      entries = [
        {
          key: input.key,
          record_type: type,
          field_path: input.field_path,
          field_schema: schemaAt(
            jsonSchema(recordSchemas[type]) as Data,
            input.field_path,
          ),
          descriptor: fieldIndex(type).find(
            (item) => item.field_path === input.field_path,
          ) ?? { path_template_convention: "Use actual indexed paths" },
        },
      ];
    }
  }
  if (input.query) {
    const query = input.query.toLowerCase();
    entries = entries.filter((entry) =>
      [
        entry.key,
        entry.label,
        entry.description,
        ...((entry.search_aliases as string[] | undefined) ?? []),
      ].some((text) => String(text).toLowerCase().includes(query)),
    );
  }
  entries = [...entries].sort((a, b) =>
    String(a.key).localeCompare(String(b.key)),
  );
  const { cursor: _cursor, ...filters } = {
    ...input,
    category,
    limit: input.key ? 1 : (input.limit ?? 50),
    catalog_version: CATALOG_VERSION,
  };
  let offset = input.cursor
    ? Number(cursors.decode(input.cursor, filters).offset)
    : 0;
  if (!Number.isSafeInteger(offset) || offset < 0)
    fail("/cursor", "Invalid page position");
  const items: Data[] = [];
  const bytes = (entry: unknown) => Buffer.byteLength(JSON.stringify(entry));
  let size = 2048;
  while (offset < entries.length && items.length < filters.limit) {
    const entry = entries[offset]!;
    const entryBytes = bytes(entry);
    if (entryBytes + 2048 > MAX_RESPONSE_BYTES)
      throw new DomainError(
        "LIMIT_EXCEEDED",
        "Complete catalog entry exceeds the response bound; request a field path",
      );
    if (size + entryBytes > MAX_RESPONSE_BYTES) break;
    items.push(entry);
    size += entryBytes;
    offset++;
  }
  const more = offset < entries.length;
  return boundedResponse({
    catalog_version: CATALOG_VERSION,
    category,
    response_variant: input.key ? "lookup" : "list",
    items,
    returned_count: items.length,
    total_count: entries.length,
    has_more: more,
    next_cursor: more ? cursors.encode(filters, { offset }) : null,
  });
}
