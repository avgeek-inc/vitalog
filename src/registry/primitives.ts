import { z } from "zod";

export const text = (max = 200) => z.string().min(1).max(max);
export const note = text(1000);
export const nonnegative = z.number().finite().min(0);
export const signed = z.number().finite();
export const count = z.number().int().min(0).max(1_000_000_000);
export const percent = nonnegative.max(100);
export const date = z.iso.date();
export const instant = z.iso.datetime({ offset: true });
export const decimal = z.union([
  z.number().finite(),
  z
    .string()
    .max(80)
    .regex(
      /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/,
      "Use finite decimal text without an exponent",
    ),
]);
export const code = z.strictObject({
  system: text(200),
  code: text(100),
  version: text(100).optional(),
  display: text(200).optional(),
});
export const codes = z.array(code).max(10);
export const comparator = z.enum(["eq", "lt", "le", "gt", "ge"]);
export const absentReason = z.enum([
  "unknown",
  "not_measured",
  "not_performed",
  "pending",
  "insufficient_specimen",
  "specimen_rejected",
  "below_detection_unquantified",
  "unreadable",
  "not_applicable",
  "withheld",
  "other",
]);
export const quantity = z.strictObject({
  kind: z.literal("quantity"),
  value: decimal,
  unit: text(80).optional(),
  original_unit: text(80).optional(),
  original_value: text(200).optional(),
  comparator: comparator.optional(),
  reported_precision: count.max(15).optional(),
});
export const interval = z.strictObject({
  kind: z.literal("interval"),
  lower: decimal,
  upper: decimal,
  unit: text(80).optional(),
  lower_inclusive: z.boolean().optional(),
  upper_inclusive: z.boolean().optional(),
  original_value_text: text(200).optional(),
});
export const coded = z.strictObject({
  kind: z.literal("coded"),
  display: text(200),
  coding: code.optional(),
});
export const ordinal = z.strictObject({
  kind: z.literal("ordinal"),
  display: text(200),
  scale: text(100),
  scale_version: text(100).optional(),
  order: z.array(text(100)).min(1).max(30).optional(),
  coding: code.optional(),
});
export const ratio = z.strictObject({
  kind: z.literal("ratio"),
  numerator: decimal,
  denominator: decimal,
  numerator_unit: text(80).optional(),
  denominator_unit: text(80).optional(),
  original_ratio_text: text(200).optional(),
});
export const titer = z.strictObject({
  kind: z.literal("titer"),
  dilution_text: text(100),
  numerator: decimal.optional(),
  denominator: decimal.optional(),
  comparator: comparator.optional(),
  assay_context: text(200).optional(),
});
export const resultText = z.strictObject({
  kind: z.literal("text"),
  text: text(1000),
});
export const absent = z.strictObject({
  kind: z.literal("absent"),
  reason: absentReason,
  explanation: text(300).optional(),
});
export const basicResults = [
  quantity,
  interval,
  coded,
  ordinal,
  ratio,
  titer,
  resultText,
  absent,
] as const;
export const pathogenResult = z.strictObject({
  kind: z.literal("pathogen_result"),
  organism_or_target: text(200),
  coding: code.optional(),
  assay: text(200).optional(),
  specimen: text(100).optional(),
  result: z.discriminatedUnion("kind", [quantity, coded, absent]),
});
export const cultureResult = z.strictObject({
  kind: z.literal("culture_result"),
  growth: coded.or(resultText),
  isolates: z
    .array(
      z.strictObject({
        isolate_label: text(100),
        organism: text(200),
        quantity: quantity.optional(),
      }),
    )
    .max(20),
});
export const susceptibilityResult = z.strictObject({
  kind: z.literal("susceptibility_result"),
  isolate_reference: text(100),
  antimicrobial: text(200),
  method: text(200).optional(),
  mic: quantity.optional(),
  disk_zone: quantity.optional(),
  interpretation: text(200),
  breakpoint_standard: text(200).optional(),
  breakpoint_version: text(100).optional(),
});
export const resultValue = z.discriminatedUnion("kind", [
  ...basicResults,
  pathogenResult,
  cultureResult,
  susceptibilityResult,
]);
export const sourceStatus = z.enum([
  "preliminary",
  "final",
  "amended",
  "corrected",
  "cancelled",
  "unknown",
]);
export const validity = z.enum(["valid", "suspect", "invalid"]);
export const sourceType = z.enum([
  "manual",
  "device",
  "laboratory",
  "calculated",
  "other",
]);
export const valueKind = z.enum([
  "measured",
  "reported",
  "estimated",
  "calculated",
]);
export const pointer = text(200).regex(
  /^(?:\/(?:[^~\/]|~[01])*)+$/,
  "Use an indexed JSON Pointer",
);
export const fieldOverride = z.strictObject({
  validity: validity.optional(),
  reason: text(300).optional(),
  source_type: sourceType.optional(),
  value_kind: valueKind.optional(),
  source_description: text(200).optional(),
  uncertainty_note: text(300).optional(),
});
export const provenance = z.strictObject({
  source_type: sourceType,
  value_kind: valueKind,
  source_description: text(200).optional(),
  source_locator: text(200).optional(),
  assumptions: z.array(text(300)).max(20).optional(),
  field_overrides: z.record(pointer, fieldOverride).optional(),
});
export const uncertainty = z.strictObject({
  note: text(300).optional(),
  confidence_label: text(100).optional(),
  lower: decimal.optional(),
  upper: decimal.optional(),
  original_value_text: text(200).optional(),
});
export const methodContext = z.strictObject({
  name: text(200).optional(),
  assay: text(200).optional(),
  assay_version: text(100).optional(),
  instrument: text(200).optional(),
  model: text(200).optional(),
  firmware_version: text(100).optional(),
  software_version: text(100).optional(),
  equation: text(300).optional(),
  reference_basis: text(200).optional(),
  calibration: text(200).optional(),
});
export const effectivePeriod = z.strictObject({
  start: date.or(instant).optional(),
  end: date.or(instant).optional(),
  time_precision: z.enum(["date", "instant", "duration", "unknown"]),
  timezone: text(100).optional(),
  duration_seconds: nonnegative.optional(),
  original_timezone: text(100).optional(),
});
export const coverage = z.strictObject({
  expected_samples: count.optional(),
  observed_samples: count.optional(),
  duration_seconds: nonnegative.optional(),
  percent: percent.optional(),
  days_covered: nonnegative.optional(),
  gaps: z.array(effectivePeriod).max(50).optional(),
});
export const reportedScore = z.strictObject({
  value: signed,
  scale: text(100),
  version: text(100).optional(),
  lower: signed.optional(),
  upper: signed.optional(),
  meaning: text(200).optional(),
  direction: z
    .enum(["higher_is_more", "higher_is_less", "source_defined", "unknown"])
    .optional(),
  components: z
    .array(z.strictObject({ key: text(100), value: signed }))
    .max(30)
    .optional(),
});
export const laterality = z.enum([
  "left",
  "right",
  "bilateral",
  "midline",
  "not_applicable",
  "unknown",
]);
export const specimenType = z.enum([
  "whole_blood",
  "serum",
  "plasma",
  "capillary_blood",
  "arterial_blood",
  "venous_blood",
  "urine",
  "stool",
  "saliva",
  "semen",
  "swab",
  "csf",
  "tissue",
  "other",
  "unknown",
]);
export const specimen = z.strictObject({
  type: specimenType,
  site: text(200).optional(),
  collection_method: text(200).optional(),
  collection_context: z.enum(["spot", "timed", "unknown"]).optional(),
  container: text(100).optional(),
  additive: text(100).optional(),
  quality_flags: z.array(text(200)).max(20).optional(),
  duration_seconds: nonnegative.optional(),
  volume: quantity.optional(),
});
export const referenceRange = z.strictObject({
  lower: decimal.optional(),
  upper: decimal.optional(),
  lower_inclusive: z.boolean().optional(),
  upper_inclusive: z.boolean().optional(),
  unit: text(80).optional(),
  text: text(500).optional(),
  age_band: z
    .strictObject({
      lower: nonnegative.optional(),
      upper: nonnegative.optional(),
      unit: z.enum(["years", "months", "days"]),
    })
    .optional(),
  sex_context: text(100).optional(),
  specimen: specimenType.optional(),
  method: text(200).optional(),
  fasting_state: text(100).optional(),
  pregnancy_context: text(200).optional(),
  gestational_context: text(200).optional(),
  source_version: text(100).optional(),
});
export const relationships = z
  .array(
    z.strictObject({
      record_id: z.uuid(),
      relationship: z.enum([
        "same_event",
        "component_of",
        "derived_from",
        "alternative_representation",
        "reported_with",
      ]),
    }),
  )
  .max(30);
export const commonData = {
  related_record_ids: relationships.optional(),
  notes: note.optional(),
};
export const thresholdBand = z.strictObject({
  label: text(100),
  lower: decimal.optional(),
  upper: decimal.optional(),
  unit: text(80),
  lower_inclusive: z.boolean().optional(),
  upper_inclusive: z.boolean().optional(),
  duration_seconds: nonnegative.optional(),
  percent: percent.optional(),
  denominator: text(100),
  definition: text(300).optional(),
});
export const scalarSummary = z.strictObject({
  mean: signed.optional(),
  min: signed.optional(),
  max: signed.optional(),
  median: signed.optional(),
  unit: text(80),
  effective_period: effectivePeriod.optional(),
  method: methodContext.optional(),
  coverage: coverage.optional(),
});
export const jsonSchema = (schema: z.ZodType) =>
  z.toJSONSchema(schema, {
    target: "draft-2020-12",
    reused: "ref",
    io: "input",
  });
