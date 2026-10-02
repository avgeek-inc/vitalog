import { DomainError, fail, pointerEscape } from "../errors.js";
import {
  CATALOG_VERSION,
  fieldConditionSemantics,
  inventory,
  label,
  labDefinitions,
  measurementDefinitions,
  measurementByKey,
  nutrientDefinitions,
  recordTypes,
  resultSchemaForLab,
  type RecordType,
} from "../registry/definitions.js";
import { catalogInput, operations, restBody } from "../registry/operations.js";
import { jsonSchema } from "../registry/primitives.js";
import { recordInputSchemas as recordSchemas } from "../registry/records.js";
import { validationRules } from "./validation.js";
import { Cursors } from "./cursor.js";
import { object, type Data } from "./types.js";
import { canonical } from "./canonical.js";

export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MCP_REQUEST_BYTE_LIMIT = 1024 * 1024;
const CATALOG_ENVELOPE_RESERVE = MCP_REQUEST_BYTE_LIMIT + 2048;
export function catalogResponseBytes(value: Data): number {
  return Buffer.byteLength(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      result: {
        content: [{ type: "text", text: JSON.stringify(value) }],
        structuredContent: value,
      },
    }),
  );
}
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
const writableSchemaCache = new Map<RecordType, Data>();
function writableSchema(type: RecordType): Data {
  if (!writableSchemaCache.has(type))
    writableSchemaCache.set(type, jsonSchema(recordSchemas[type]) as Data);
  return writableSchemaCache.get(type)!;
}
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
const normalizedSchemaCache = new WeakMap<object, WeakMap<object, unknown>>();
function normalizedSchema(value: unknown, root: Data): unknown {
  if (Array.isArray(value))
    return value.map((item) => normalizedSchema(item, root));
  if (!value || typeof value !== "object") return value;
  let cache = normalizedSchemaCache.get(root);
  if (!cache) {
    cache = new WeakMap();
    normalizedSchemaCache.set(root, cache);
  }
  if (cache.has(value)) return cache.get(value);
  const node = resolveRef(object(value), root);
  const normalized = Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => key !== "$defs")
      .map(([key, item]) => [key, normalizedSchema(item, root)]),
  );
  cache.set(value, normalized);
  return normalized;
}
function distinctAlternatives(nodes: Data[], root: Data): Data {
  const entries = new Map<string, Data>();
  function add(raw: Data) {
    const node = resolveRef(raw, root);
    if (
      Array.isArray(node.anyOf) &&
      Object.keys(node).every((key) =>
        ["anyOf", "$schema", "$defs"].includes(key),
      )
    ) {
      (node.anyOf as Data[]).forEach(add);
      return;
    }
    entries.set(canonical(normalizedSchema(node, root)), node);
  }
  nodes.forEach(add);
  const branches = [...entries.values()];
  return branches.length === 1 ? branches[0]! : { anyOf: branches };
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
  return {
    ...selfContained(distinctAlternatives(nodes, schema), schema),
    $schema: "https://json-schema.org/draft/2020-12/schema",
  };
}
type VariantCondition =
  | { field_path: string; equals: string | number | boolean | null }
  | { field_path: string; one_of: string[] }
  | { field_path: string; map_key_is: string }
  | { field_path: string; map_key_in: string[] }
  | { field_path: string; not_equals: "absent" }
  | { field_path: string; missing: true }
  | { field_path: string; requires_enclosing_unit: true };
function conditionLabel(condition: VariantCondition): string {
  if ("equals" in condition)
    return `${condition.field_path}=${String(condition.equals)}`;
  if ("map_key_is" in condition)
    return `${condition.field_path} key=${condition.map_key_is}`;
  if ("map_key_in" in condition)
    return `${condition.field_path} key in ${condition.map_key_in.length} declared choices`;
  if ("one_of" in condition)
    return `${condition.field_path} in ${condition.one_of.length} declared choices`;
  if ("not_equals" in condition)
    return `${condition.field_path} differs from ${condition.not_equals}`;
  if ("missing" in condition) return `${condition.field_path} is not supplied`;
  return `${condition.field_path} has a quantity without its own unit`;
}
function compressedConditions(conditions: Data[]): Data[] {
  const groups = new Map<string, Data>();
  for (const condition of conditions) {
    const rules = condition.all_of as VariantCondition[];
    const selector = rules.find(
      (rule) => "map_key_is" in rule || "one_of" in rule,
    );
    if (!selector) {
      groups.set(canonical(condition), condition);
      continue;
    }
    const rest = rules.filter((rule) => rule !== selector);
    const base = { ...condition, all_of: rest };
    const groupKey = canonical({
      ...base,
      selector_path: selector.field_path,
      selector_kind: "map_key_is" in selector ? "map_key_in" : "one_of",
    });
    const keys =
      "map_key_is" in selector
        ? [selector.map_key_is]
        : "one_of" in selector
          ? selector.one_of
          : [];
    const group = groups.get(groupKey);
    if (group) {
      const existing = (group.all_of as VariantCondition[]).at(-1)!;
      if ("map_key_in" in existing)
        existing.map_key_in = [...new Set([...existing.map_key_in, ...keys])];
      else if ("one_of" in existing)
        existing.one_of = [...new Set([...existing.one_of, ...keys])];
    } else
      groups.set(groupKey, {
        ...base,
        all_of: [
          ...rest,
          "map_key_is" in selector
            ? { field_path: selector.field_path, map_key_in: [...keys] }
            : { field_path: selector.field_path, one_of: [...keys] },
        ],
      });
  }
  return [...groups.values()];
}
export function fieldIndex(type: RecordType): Data[] {
  if (fieldIndexCache.has(type)) return fieldIndexCache.get(type)!;
  const schema = writableSchema(type);
  const fields = new Map<string, Data>();
  const schemaSets = new Map<
    string,
    {
      signatures: Set<string>;
      bodies: Data[];
    }
  >();
  const conditionSets = new Map<
    string,
    { applicable: Set<string>; required: Set<string> }
  >();
  function addCondition(
    entry: Data,
    name: "applicable_conditions" | "required_conditions",
    condition: Data,
  ) {
    const signatures = conditionSets.get(String(entry.field_path))![
      name === "applicable_conditions" ? "applicable" : "required"
    ];
    const signature = canonical(condition);
    if (!signatures.has(signature)) {
      signatures.add(signature);
      (entry[name] as Data[]).push(condition);
    }
  }
  function visit(
    raw: Data,
    path: string,
    required: boolean,
    variants: VariantCondition[],
  ) {
    const node = resolveRef(raw, schema);
    const parent = path.split("/").slice(0, -1).join("/");
    let entry = fields.get(path);
    const nullable =
      node.type === "null" ||
      alternatives(node).some((item) => item.type === "null");
    if (path && !entry) {
      schemaSets.set(path, {
        signatures: new Set([canonical(normalizedSchema(node, schema))]),
        bodies: [node],
      });
      conditionSets.set(path, { applicable: new Set(), required: new Set() });
      entry = {
        key: path.split("/").at(-1),
        label: label(path.split("/").at(-1)!),
        record_type: type,
        field_path: path,
        parent_path: parent,
        required,
        required_when_parent_present: required,
        nullable,
        applicable_variants: [],
        applicable_conditions: [],
        field_schema: {},
        path_template_convention:
          "{index} is an array index; {key} is one of map_keys. Writes and overrides require actual indexed JSON Pointers.",
        required_conditions: [],
        introduced_in: "1.0.0",
        deprecated: false,
      };
      fields.set(path, entry);
    } else if (path && entry) {
      const schemas = schemaSets.get(path)!;
      const signature = canonical(normalizedSchema(node, schema));
      if (!schemas.signatures.has(signature)) {
        schemas.signatures.add(signature);
        schemas.bodies.push(node);
      }
      entry.nullable = !!entry.nullable || nullable;
      if (required) {
        entry.required = true;
        entry.required_when_parent_present = true;
      }
    }
    if (entry) {
      addCondition(entry, "applicable_conditions", { all_of: variants });
      if (required)
        addCondition(entry, "required_conditions", {
          all_of: variants,
          parent_path: parent,
        });
    }
    for (const branch of alternatives(node)) {
      const resolved = resolveRef(branch, schema);
      const tags: VariantCondition[] = Object.entries(
        object(resolved.properties),
      ).flatMap<VariantCondition>(([field, value]) => {
        if (
          !((resolved.required as string[] | undefined) ?? []).includes(field)
        )
          return [];
        const definition = object(value);
        const field_path = `${path}/${pointerEscape(field)}`;
        if (definition.const !== undefined)
          return [
            {
              field_path,
              equals: definition.const as string | number | boolean | null,
            },
          ];
        if (
          [
            "kind",
            "entry_kind",
            "analyte_kind",
            "metric_key",
            "study_type",
            "analyte_key",
          ].includes(field) &&
          Array.isArray(definition.enum)
        )
          return [{ field_path, one_of: definition.enum as string[] }];
        return [];
      });
      visit(branch, path, required, [...variants, ...tags]);
    }
    if (node.type === "array")
      visit(object(node.items), `${path}/{index}`, true, variants);
    const properties = object(node.properties);
    const keys = Object.keys(properties);
    if (path === "/components") {
      const template = `${path}/{key}`;
      for (const [key, value] of Object.entries(properties)) {
        visit(object(value), template, false, [
          ...variants,
          { field_path: template, map_key_is: key },
        ]);
        fields.get(template)!.map_keys = [
          ...new Set([
            ...((fields.get(template)!.map_keys as string[] | undefined) ?? []),
            key,
          ]),
        ];
      }
    } else if (
      keys.length > 100 &&
      !path.endsWith("/nutrients") &&
      !path.endsWith("/nutrient_contributions")
    ) {
      visit(object(properties[keys[0]!]!), `${path}/{key}`, false, variants);
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
  const index = [...fields.values()];
  const contextRequirements = new Set(
    measurementDefinitions.flatMap((definition) =>
      definition.required_context_paths.flatMap((path) =>
        path
          .split("/")
          .slice(1)
          .map(
            (_, position, parts) =>
              `/${parts.slice(0, position + 1).join("/")}`,
          ),
      ),
    ),
  );
  for (const field of index) {
    const path = String(field.field_path);
    field.required_conditions = (field.required_conditions as Data[]).map(
      (condition) => {
        const all_of = [...(condition.all_of as VariantCondition[])];
        const scalar = all_of.some(
          (rule) =>
            "equals" in rule &&
            rule.field_path === "/kind" &&
            rule.equals === "scalar",
        );
        const component = path.startsWith("/components/{key}/");
        const valuePath = component
          ? "/components/{key}/value"
          : type === "lab_result"
            ? "/result"
            : "/value";
        const outerUnit = component ? "/components/{key}/unit" : "/unit";
        if (
          (type === "lab_result" ||
            (type === "measurement" && (scalar || component))) &&
          path.endsWith("/unit")
        ) {
          if (path === outerUnit)
            all_of.push({
              field_path: valuePath,
              requires_enclosing_unit: true,
            });
          else if (path.startsWith(valuePath + "/"))
            all_of.push(
              { field_path: outerUnit, missing: true },
              {
                field_path: `${path.slice(0, -5)}/kind`,
                one_of: ["quantity", "interval"],
              },
            );
        }
        const contextPath = component
          ? path.slice("/components/{key}/context".length)
          : path;
        if (
          type === "measurement" &&
          ((scalar && contextRequirements.has(contextPath)) ||
            (component &&
              (path === "/components/{key}/context" ||
                (path.startsWith("/components/{key}/context/") &&
                  contextRequirements.has(contextPath)))))
        )
          all_of.push({
            field_path: `${valuePath}/kind`,
            not_equals: "absent",
          });
        return { ...condition, all_of };
      },
    );
    field.field_schema = selfContained(
      distinctAlternatives(
        schemaSets.get(String(field.field_path))!.bodies,
        schema,
      ),
      schema,
    );
    field.applicable_conditions = compressedConditions(
      field.applicable_conditions as Data[],
    );
    field.required_conditions = compressedConditions(
      field.required_conditions as Data[],
    );
    field.applicable_variants = [
      ...new Set(
        (field.applicable_conditions as Data[]).flatMap((condition) =>
          (condition.all_of as VariantCondition[]).map(conditionLabel),
        ),
      ),
    ];
  }
  fieldIndexCache.set(type, index);
  return index;
}
const fieldIndexCache = new Map<RecordType, Data[]>();
const schemaCache = new Map<RecordType, Data>();
const measurementDescriptorCache = new Map<string, Data>();
function compactFieldIndex(type: RecordType): Data {
  const definitions: Data = {};
  const references = new Map<string, string>();
  const referenceConditions = (value: unknown): Data[] =>
    (value as Data[]).map(({ all_of, ...metadata }) => {
      const signature = canonical(all_of);
      let reference = references.get(signature);
      if (!reference) {
        const name = `condition_${references.size}`;
        definitions[name] = all_of;
        reference = `#/condition_definitions/${name}`;
        references.set(signature, reference);
      }
      return { condition_ref: reference, ...metadata };
    });
  return {
    field_index: fieldIndex(type).map((field) => ({
      ...field,
      applicable_conditions: referenceConditions(field.applicable_conditions),
      required_conditions: referenceConditions(field.required_conditions),
    })),
    condition_definitions: definitions,
    condition_semantics: fieldConditionSemantics,
    condition_reference_convention:
      "condition_ref is a local JSON Pointer into this entry's condition_definitions. Field lookups expand these conditions inline.",
  };
}
export function measurementDescriptor(key: string): Data {
  if (measurementDescriptorCache.has(key))
    return measurementDescriptorCache.get(key)!;
  const definition = measurementByKey.get(key);
  if (!definition)
    throw new DomainError("NOT_FOUND", "Unknown measurement key");
  const root = writableSchema("measurement");
  function matchingBranches(raw: Data): Data[] {
    const node = resolveRef(raw, root);
    const properties = object(node.properties);
    const discriminator = object(properties.kind).const;
    const identity = object(
      properties[
        definition!.kind === "study_summary" ? "study_type" : "metric_key"
      ],
    );
    if (
      discriminator === definition!.kind &&
      (definition!.kind === "blood_pressure" ||
        identity.const === key ||
        (Array.isArray(identity.enum) && identity.enum.includes(key)))
    )
      return [node];
    return alternatives(node).flatMap(matchingBranches);
  }
  const matches = matchingBranches(root);
  if (!matches.length)
    throw new Error(`Missing registered measurement schema: ${key}`);
  const branches = matches.map<Data>((branch) => {
    const properties = { ...object(branch.properties) };
    if (definition.kind === "study_summary") {
      properties.study_type = { type: "string", const: key };
      const components = resolveRef(object(properties.components), root);
      properties.components = {
        ...components,
        properties: Object.fromEntries(
          Object.entries(object(components.properties)).filter(([component]) =>
            definition.component_keys.includes(component),
          ),
        ),
      };
      if (key !== "cgm_summary") delete properties.cgm;
      if (key !== "ambulatory_bp_summary") delete properties.ambulatory_bp;
    } else if (definition.kind === "scalar")
      properties.metric_key = { type: "string", const: key };
    return { ...branch, properties };
  });
  const writable = {
    ...selfContained(
      branches.length === 1 ? branches[0]! : { anyOf: branches },
      root,
    ),
    $schema: "https://json-schema.org/draft/2020-12/schema",
  };
  const valuePaths = definition.value_field_paths;
  const contextFields = [
    ...new Set(
      branches.flatMap((branch) => Object.keys(object(branch.properties))),
    ),
  ].filter(
    (field) =>
      !["kind", "metric_key", "study_type"].includes(field) &&
      !valuePaths.includes(`/${field}`),
  );
  const descriptor = {
    ...definition,
    field_schema:
      definition.kind === "scalar" ? schemaAt(writable, "/value") : writable,
    writable_data_schema: writable,
    unit_policy:
      definition.kind === "study_summary"
        ? "Each component uses its registered result/unit policy; study-specific quantities retain their supplied units."
        : "Numeric quantities and intervals require one recognized supplied unit, on the result or its containing field. Original units remain source metadata; no conversion is performed.",
    context_fields: contextFields,
    context_field_definitions: contextFields.map((field) => ({
      field_path: `/${field}`,
      parent_path: "",
      field_schema: schemaAt(writable, `/${field}`),
      required: branches.every((branch) =>
        ((branch.required as string[] | undefined) ?? []).includes(field),
      ),
      required_conditions: definition.required_context_conditions.filter(
        (condition) =>
          condition.field_path === `/${field}` ||
          condition.field_path.startsWith(`/${field}/`),
      ),
    })),
    field_bindings: valuePaths.map((field_path) => ({
      record_type: "measurement",
      field_path,
      field_schema: schemaAt(writable, field_path),
    })),
  };
  measurementDescriptorCache.set(key, descriptor);
  return descriptor;
}
function concreteFieldDescriptor(
  type: RecordType,
  path: string,
  schema: Data,
): Data {
  const parts = path.split("/").slice(1);
  const descriptor = fieldIndex(type).find((item) => {
    const template = String(item.field_path).split("/").slice(1);
    return (
      template.length === parts.length &&
      template.every(
        (part, index) =>
          part === parts[index] ||
          part === "{key}" ||
          (part === "{index}" && /^(?:0|[1-9]\d*)$/.test(parts[index]!)),
      )
    );
  });
  if (!descriptor)
    throw new Error(`Missing registered field descriptor: ${type}${path}`);
  const applicable = concreteConditions(
    descriptor.applicable_conditions,
    String(descriptor.field_path),
    path,
  );
  const required = concreteConditions(
    descriptor.required_conditions,
    String(descriptor.field_path),
    path,
  );
  return {
    ...descriptor,
    key: parts.at(-1)!.replaceAll("~1", "/").replaceAll("~0", "~"),
    label: label(parts.at(-1)!),
    field_path: path,
    parent_path: path.split("/").slice(0, -1).join("/"),
    path_template: descriptor.field_path,
    applicable_conditions: applicable,
    applicable_variants: [
      ...new Set(
        applicable.flatMap((condition) =>
          (condition.all_of as VariantCondition[]).map(conditionLabel),
        ),
      ),
    ],
    required: required.length > 0,
    required_when_parent_present: required.length > 0,
    required_conditions: required,
    field_schema: schema,
    condition_semantics: fieldConditionSemantics,
  };
}
function concreteConditions(
  value: unknown,
  template: string,
  path: string,
): Data[] {
  const templateParts = template.split("/");
  const parts = path.split("/");
  function concretize(pointer: string): string {
    return pointer
      .split("/")
      .map((part, index) =>
        (part === "{index}" || part === "{key}") &&
        templateParts[index] === part
          ? parts[index]
          : part,
      )
      .join("/");
  }
  return (value as Data[])
    .filter((condition) =>
      (condition.all_of as Data[]).every((rule) => {
        if (
          typeof rule.map_key_is !== "string" &&
          !Array.isArray(rule.map_key_in)
        )
          return true;
        const position = String(rule.field_path)
          .split("/")
          .lastIndexOf("{key}");
        return (
          position === -1 ||
          (typeof rule.map_key_is === "string"
            ? parts[position] === rule.map_key_is
            : (rule.map_key_in as string[]).includes(parts[position]!))
        );
      }),
    )
    .map((condition) => ({
      ...condition,
      all_of: (condition.all_of as Data[]).map((rule) => ({
        ...rule,
        field_path: concretize(String(rule.field_path)),
      })),
      ...(condition.parent_path !== undefined
        ? { parent_path: concretize(String(condition.parent_path)) }
        : {}),
    }));
}
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
      writable_data_schema: writableSchema(type),
      correction_data_schema: writableSchema(type),
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
      ...compactFieldIndex(type),
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
      entries = measurementDefinitions.map((entry) =>
        measurementDescriptor(entry.key),
      );
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
      const fieldSchema = schemaAt(writableSchema(type), input.field_path);
      entries = [
        {
          key: input.key,
          record_type: type,
          field_path: input.field_path,
          field_schema: fieldSchema,
          descriptor: concreteFieldDescriptor(
            type,
            input.field_path,
            fieldSchema,
          ),
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
  const bytes = (entry: unknown) => {
    const serialized = JSON.stringify(entry);
    return (
      Buffer.byteLength(serialized) +
      Buffer.byteLength(JSON.stringify(serialized))
    );
  };
  // Both transports page against the MCP text-plus-structured encoding, including a possible request-sized JSON-RPC id.
  let size = CATALOG_ENVELOPE_RESERVE;
  while (offset < entries.length && items.length < filters.limit) {
    const entry = entries[offset]!;
    const entryBytes = bytes(entry);
    if (entryBytes + CATALOG_ENVELOPE_RESERVE > MAX_RESPONSE_BYTES)
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
