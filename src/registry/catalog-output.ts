import { z } from "zod";
import {
  analyteKeys,
  CATALOG_VERSION,
  inventory,
  measurementKeys,
  nutrientKeys,
  recordTypes,
  scalarKeys,
} from "./definitions.js";
import * as p from "./primitives.js";

const enumeration = (values: string[]) =>
  z.enum(values as [string, ...string[]]);
const schemaDocument = z.json();
const path = z.string().max(200);
const strings = z.array(p.text(4000));
const key = p.text(200);
const nutrientKey = enumeration(nutrientKeys);
const analyteKey = enumeration(analyteKeys);
const measurementKey = enumeration(measurementKeys);
const panelKey = enumeration(
  inventory.lab_panels.map((panel) => panel.panel_key),
);
const condition = z.union([
  z.strictObject({
    field_path: path,
    equals: z.string().or(z.number()).or(z.boolean()).nullable(),
  }),
  z.strictObject({ field_path: path, one_of: strings }),
  z.strictObject({ field_path: path, map_key_is: p.text(200) }),
  z.strictObject({ field_path: path, map_key_in: strings }),
  z.strictObject({ field_path: path, not_equals: z.literal("absent") }),
  z.strictObject({ field_path: path, missing: z.literal(true) }),
  z.strictObject({
    field_path: path,
    requires_enclosing_unit: z.literal(true),
  }),
]);
const conditionSemantics = z.strictObject({
  missing: p.text(500),
  not_equals: p.text(500),
  requires_enclosing_unit: p.text(500),
});
const conditionReference = z
  .string()
  .max(200)
  .regex(/^#\/condition_definitions\/condition_\d+$/);
const applicableCondition = z.union([
  z.strictObject({ all_of: z.array(condition) }),
  z.strictObject({ condition_ref: conditionReference }),
]);
const requiredCondition = z.union([
  z.strictObject({ all_of: z.array(condition), parent_path: path }),
  z.strictObject({ condition_ref: conditionReference, parent_path: path }),
]);
export const fieldDescriptorSchema = z.strictObject({
  key,
  label: p.text(200),
  record_type: z.enum(recordTypes),
  field_path: path,
  parent_path: path,
  required: z.boolean(),
  required_when_parent_present: z.boolean(),
  nullable: z.boolean(),
  applicable_variants: strings,
  applicable_conditions: z.array(applicableCondition),
  field_schema: schemaDocument,
  path_template_convention: p.text(300),
  required_conditions: z.array(requiredCondition),
  introduced_in: p.text(100),
  deprecated: z.boolean(),
  map_keys: strings.optional(),
  path_template: path.optional(),
  condition_semantics: conditionSemantics.optional(),
});
const definition = {
  key,
  label: p.text(200),
  description: p.text(4000),
  search_aliases: strings,
  introduced_in: p.text(100),
  deprecated: z.boolean(),
};
const nutrientDescriptorSchema = z.strictObject({
  ...definition,
  key: nutrientKey,
  group_key: enumeration(Object.keys(inventory.nutrient_groups)),
  unit: p.text(80),
  field_path: path,
  value_schema: schemaDocument,
  quantity_basis: p.text(200),
  qualifier_path: path,
  notes: p.text(4000),
  record_type: z.literal("nutrition"),
  field_schema: schemaDocument,
  required: z.literal(false),
  nullable: z.literal(true),
  applicable_variants: z.array(z.enum(["intake", "daily_total"])),
  qualifier_support: z.array(
    z.enum(["exact", "bound", "interval", "unquantified"]),
  ),
  quantity_kind: z.literal("consumed_amount"),
  component_form: nutrientKey,
  expression_basis: p.text(200),
  source_definition_refs: strings,
  aggregation: p.text(500),
  aggregation_role: p.text(200),
  non_additive_relationships: z.array(z.array(nutrientKey)),
  alternative_representation_of: p.text(100).nullable(),
  supplement_binding: path,
  trend_supported: z.boolean(),
  trend_key: p.text(200),
  series_identity_dimensions: strings,
  qualified_value_summary_policy: p.text(500),
  normalization_policy: p.text(500),
});
const panelDescriptorSchema = z.strictObject({
  key: panelKey,
  panel_key: panelKey,
  label: p.text(200),
  description: p.text(500),
  search_aliases: strings,
  analyte_keys: z.array(analyteKey).max(424),
  analyte_count: p.count,
  analyte_lookup: z.strictObject({
    category: z.literal("lab_analytes"),
    panel_key: panelKey,
  }),
});
const labDescriptorSchema = z.strictObject({
  ...definition,
  key: analyteKey,
  record_type: z.literal("lab_result"),
  panel_keys: z.array(panelKey).max(30),
  result_variants: z.array(
    z.enum([
      "quantity",
      "interval",
      "coded",
      "ordinal",
      "ratio",
      "titer",
      "text",
      "absent",
      "pathogen_result",
      "culture_result",
      "susceptibility_result",
    ]),
  ),
  recognized_units: strings,
  recognized_units_policy: p.text(500),
  unit_policy: p.text(500),
  required_context: strings,
  series_identity_dimensions: strings,
  missing_context_policy: p.text(500),
  normalization_policy: p.text(500),
  external_codes: p.codes,
  trend_supported: z.boolean(),
  trend_key: p.text(200),
  source_status_policy: p.text(500),
  qualified_value_summary_policy: p.text(500),
  field_path: path,
  field_schema: schemaDocument,
});
const measurementContextCondition = z.strictObject({
  field_path: path,
  when: z.strictObject({
    result_kind: z.strictObject({ not: z.literal("absent") }),
  }),
});
const measurementDescriptorSchema = z.strictObject({
  ...definition,
  key: measurementKey,
  group_key: enumeration(Object.keys(inventory.measurement_groups)),
  record_type: z.literal("measurement"),
  logging_identifier: measurementKey,
  kind: z.enum(["scalar", "blood_pressure", "study_summary"]),
  recognized_units: strings,
  canonical_unit: p.text(80).nullable(),
  allow_negative: z.boolean(),
  result_variants: z.array(
    z.enum(["quantity", "interval", "ratio", "ordinal", "absent"]),
  ),
  required_context: strings,
  required_context_paths: z.array(path),
  required_context_conditions: z.array(measurementContextCondition),
  field_path: path,
  value_field_paths: z.array(path),
  component_keys: z.array(enumeration(scalarKeys)),
  field_override_policy: p.text(500),
  series_identity_dimensions: strings,
  trend_supported: z.boolean(),
  trend_key: p.text(200),
  aggregation: p.text(500),
  missing_context_policy: p.text(500),
  normalization_policy: p.text(500),
  field_schema: schemaDocument,
  writable_data_schema: schemaDocument,
  unit_policy: p.text(500),
  context_fields: strings,
  context_field_definitions: z.array(
    z.strictObject({
      field_path: path,
      parent_path: path,
      field_schema: schemaDocument,
      required: z.boolean(),
      required_conditions: z.array(measurementContextCondition),
    }),
  ),
  field_bindings: z.array(
    z.strictObject({
      record_type: z.literal("measurement"),
      field_path: path,
      field_schema: schemaDocument,
    }),
  ),
});
const recordDescriptorSchema = z.strictObject({
  key: z.enum(recordTypes),
  label: p.text(200),
  description: p.text(500),
  record_type: z.enum(recordTypes),
  record_schema_version: z.literal(2),
  writable_data_schema: schemaDocument.optional(),
  correction_data_schema: schemaDocument.optional(),
  logging_contracts: z
    .array(
      z.strictObject({
        tool_name: p.text(100),
        input_schema: schemaDocument.optional(),
        output_schema: schemaDocument.optional(),
        rest_method: z.literal("POST"),
        rest_path: p.text(100),
        request_schema: schemaDocument.optional(),
        response_schema: schemaDocument.optional(),
        idempotency_header: z
          .strictObject({
            name: z.literal("Idempotency-Key"),
            required: z.literal(true),
          })
          .optional(),
      }),
    )
    .max(1),
  field_index: z.array(fieldDescriptorSchema),
  condition_definitions: z.record(
    z.string().regex(/^condition_\d+$/),
    z.array(condition),
  ),
  condition_reference_convention: p.text(300),
  condition_semantics: conditionSemantics,
  validation_rules: strings,
  introduced_in: p.text(100),
  deprecated: z.boolean(),
});
const fieldLookupSchema = z.strictObject({
  key: z.enum(recordTypes),
  record_type: z.enum(recordTypes),
  field_path: path,
  field_schema: schemaDocument,
  descriptor: fieldDescriptorSchema,
});
const category = z.enum([
  "overview",
  "nutrients",
  "lab_panels",
  "lab_analytes",
  "measurements",
  "record_schemas",
]);
const overview = z.strictObject({
  catalog_version: z.literal(CATALOG_VERSION),
  category: z.literal("overview"),
  response_variant: z.literal("overview"),
  categories: z.array(category).max(6),
  record_types: z.array(z.enum(recordTypes)).max(8),
  counts: z.strictObject({
    nutrients: p.count,
    lab_panels: p.count,
    lab_analytes: p.count,
    measurements: p.count,
    record_schemas: p.count,
  }),
  panel_keys: z.array(panelKey).max(30),
  nutrient_groups: z.record(
    enumeration(Object.keys(inventory.nutrient_groups)),
    p.count,
  ),
  measurement_groups: z.record(
    enumeration(Object.keys(inventory.measurement_groups)),
    p.count,
  ),
  custom_analyte_policy: p.text(500),
  discovery_examples: z.array(
    z.strictObject({
      category,
      panel_key: panelKey.optional(),
      key: p.text(100).optional(),
      include_schema: z.boolean().optional(),
    }),
  ),
  openapi_path: z.literal("/openapi.json"),
  record_schema_path: p.text(100),
});
const page = <C extends string, S extends z.ZodType>(name: C, entry: S) =>
  z.strictObject({
    catalog_version: z.literal(CATALOG_VERSION),
    category: z.literal(name),
    response_variant: z.enum(["list", "lookup"]),
    items: z.array(entry).max(100),
    returned_count: p.count,
    total_count: p.count,
    has_more: z.boolean(),
    next_cursor: p.text(2000).nullable(),
  });
export const catalogOutputSchema = z.discriminatedUnion("category", [
  overview,
  page("nutrients", nutrientDescriptorSchema),
  page("lab_panels", panelDescriptorSchema),
  page("lab_analytes", labDescriptorSchema),
  page("measurements", measurementDescriptorSchema),
  page("record_schemas", z.union([recordDescriptorSchema, fieldLookupSchema])),
]);
