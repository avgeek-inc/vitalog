import inventory from "./inventory.json" with { type: "json" };
import { z } from "zod";
import {
  absent,
  coded,
  cultureResult,
  interval,
  ordinal,
  pathogenResult,
  quantity,
  ratio,
  resultText,
  susceptibilityResult,
  titer,
} from "./primitives.js";

export { inventory };
export const CATALOG_VERSION = "1.0.3";
export const fieldConditionSemantics = {
  missing: "True when the field at field_path is not supplied.",
  not_equals:
    "True when the supplied field differs from the stated value, including when that field is not supplied.",
  requires_enclosing_unit:
    "True when a decimal, quantity, or interval lacks its own supplied unit, including unitless quantitative children of a pathogen, culture, or susceptibility result.",
};
export const RECORD_SCHEMA_VERSION = 2;
export const recordTypes = [
  "measurement",
  "nutrition",
  "hydration",
  "activity",
  "sleep",
  "checkin",
  "intake",
  "lab_result",
] as const;
export type RecordType = (typeof recordTypes)[number];
export const moodValues = [
  "very_low",
  "low",
  "neutral",
  "good",
  "great",
] as const;
export const nutrientKeys = inventory.nutrient_entries.map(
  (entry) => entry.key,
);
export const analyteKeys = inventory.lab_analytes.map(
  (entry) => entry.analyte_key,
);
export const measurementKeys = Object.values(
  inventory.measurement_groups,
).flat();
export const studyKeys = inventory.measurement_groups.study_summaries;
export const scalarKeys = measurementKeys.filter(
  (key) => !studyKeys.includes(key) && key !== "blood_pressure",
);
export const seriesIdentityFields = [
  "method",
  "specimen",
  "specimen_context",
  "instrument",
  "assay_version",
  "measurement_site",
  "body_region",
  "laterality",
  "body_position",
  "resting_state",
  "fasting_context",
  "fasting_state",
  "meal_state",
  "hydration_context",
  "time_since_meal_minutes",
  "exercise_context",
  "oxygen_context",
  "temperature_site",
  "reference_equation",
  "classification_metadata",
  "quantity_context",
  "challenge_context",
  "sampling_context",
  "device_context",
  "reference_ranges",
  "source_reference_range",
  "original_unit",
  "laboratory",
  "laboratory_site",
  "collection_clock_time",
] as const;
export const label = (key: string) => key.replaceAll("_", " ");

const units: Record<string, string[]> = {};
const bind = (keys: string, values: string[]) =>
  keys.split(" ").forEach((key) => {
    units[key] = values;
  });
bind(
  "weight fat_mass lean_mass fat_free_mass skeletal_muscle_mass appendicular_lean_mass segmental_fat_mass segmental_lean_mass",
  ["kg", "g", "lb"],
);
bind(
  "height waist_circumference hip_circumference chest_circumference neck_circumference upper_arm_circumference thigh_circumference calf_circumference",
  ["cm", "m", "in"],
);
bind(
  "body_fat_percent body_water_percent segmental_body_fat_percent hrv_pnn50 atrial_fibrillation_burden left_ventricular_ejection_fraction oxygen_saturation reported_percent_predicted",
  ["%"],
);
bind("global_longitudinal_strain", ["%"]);
bind(
  "total_body_water intracellular_water extracellular_water fev1 fvc slow_vital_capacity total_lung_capacity residual_volume functional_residual_capacity",
  ["L", "mL"],
);
bind(
  "extracellular_total_water_ratio waist_hip_ratio waist_height_ratio ankle_brachial_index fev1_fvc_ratio fev1_vc_ratio",
  ["1", "%"],
);
bind("visceral_fat_area", ["cm2"]);
bind("visceral_fat_level", ["source_level"]);
bind("phase_angle p_axis qrs_axis t_axis refraction_axis", ["deg"]);
bind("skinfold_thickness", ["mm", "cm"]);
bind("bmi fat_mass_index fat_free_mass_index appendicular_lean_mass_index", [
  "kg/m2",
]);
bind("body_surface_area", ["m2"]);
bind(
  "blood_pressure pulse_pressure mean_arterial_pressure intraocular_pressure",
  ["mmHg", "kPa"],
);
bind("heart_rate ventilatory_threshold_heart_rate", ["bpm"]);
bind("heart_rate_recovery", ["bpm", "bpm_drop"]);
bind("hrv_sdnn hrv_rmssd pr_interval qrs_duration qt_interval qtc_interval", [
  "ms",
]);
bind("pulse_wave_velocity gait_speed", ["m/s"]);
bind("premature_ventricular_contraction_count sit_to_stand_repetitions", [
  "count",
]);
bind("respiratory_rate", ["breaths/min"]);
bind("body_temperature skin_temperature", ["Cel", "degF"]);
bind("skin_temperature_deviation", ["Cel", "degF"]);
bind("peripheral_perfusion_index", ["%", "1"]);
bind("peak_expiratory_flow", ["L/min", "L/s"]);
bind("fef25_75", ["L/s"]);
bind("diffusing_capacity_co", ["mL/min/mmHg", "mmol/min/kPa"]);
bind("carbon_monoxide_transfer_coefficient", [
  "mL/min/mmHg/L",
  "mmol/min/kPa/L",
]);
bind("fractional_exhaled_nitric_oxide breath_acetone", ["ppb", "ppm"]);
bind("blood_glucose interstitial_glucose", ["mg/dL", "mmol/L"]);
bind("blood_beta_hydroxybutyrate blood_ketones", ["mmol/L", "mg/dL"]);
bind("vo2_max_absolute ventilatory_threshold_oxygen_uptake", [
  "L/min",
  "mL/min",
]);
bind("vo2_max_relative", ["mL/kg/min"]);
bind("ventilatory_threshold_power", ["W"]);
bind("grip_strength", ["kg", "N"]);
bind("six_minute_walk_distance", ["m"]);
bind(
  "timed_up_and_go_duration sit_to_stand_duration single_leg_stance_duration",
  ["s"],
);
bind("bone_mineral_density_areal", ["g/cm2"]);
bind("bone_mineral_content", ["g"]);
bind("bone_density_t_score bone_density_z_score", ["1"]);
bind("visual_acuity_snellen", ["ratio"]);
bind("visual_acuity_logmar", ["logMAR"]);
bind("spherical_refraction cylindrical_refraction", ["diopter"]);
bind("hearing_threshold", ["dB_HL", "dB_SPL"]);

const signedKeys = new Set([
  "skin_temperature_deviation",
  "body_temperature",
  "skin_temperature",
  "bone_density_t_score",
  "bone_density_z_score",
  "p_axis",
  "qrs_axis",
  "t_axis",
  "global_longitudinal_strain",
  "visual_acuity_logmar",
  "spherical_refraction",
  "cylindrical_refraction",
  "hearing_threshold",
]);
const requiredContexts: Record<string, string[]> = {
  segmental_fat_mass: ["body_region", "laterality"],
  segmental_lean_mass: ["body_region", "laterality"],
  segmental_body_fat_percent: ["body_region", "laterality"],
  hearing_threshold: ["frequency_hz", "laterality", "conduction"],
  heart_rate_recovery: ["recovery_kind", "recovery_interval_seconds"],
};
const requiredContextPaths: Record<string, string[]> = {
  segmental_fat_mass: ["/body_region", "/laterality"],
  segmental_lean_mass: ["/body_region", "/laterality"],
  segmental_body_fat_percent: ["/body_region", "/laterality"],
  hearing_threshold: [
    "/classification_metadata/frequency_hz",
    "/laterality",
    "/classification_metadata/conduction",
  ],
  heart_rate_recovery: [
    "/classification_metadata/recovery_kind",
    "/classification_metadata/recovery_interval_seconds",
  ],
};
export const studyComponentKeys: Record<string, string[]> = {
  cgm_summary: ["blood_glucose", "interstitial_glucose"],
  ambulatory_bp_summary: [
    "heart_rate",
    "pulse_pressure",
    "mean_arterial_pressure",
  ],
  spirometry_summary: inventory.measurement_groups.respiratory_temperature,
  body_composition_summary:
    inventory.measurement_groups.anthropometry_body_composition,
  dxa_summary: [
    ...inventory.measurement_groups.bone,
    ...inventory.measurement_groups.anthropometry_body_composition,
  ],
  ecg_summary: inventory.measurement_groups.cardiovascular,
  echocardiography_summary: inventory.measurement_groups.cardiovascular,
  functional_test_summary: inventory.measurement_groups.fitness_function,
};
for (const key of Object.keys(studyComponentKeys))
  studyComponentKeys[key] = studyComponentKeys[key]!.filter((component) =>
    scalarKeys.includes(component),
  );
export const measurementDefinitions = measurementKeys.map((key) => ({
  key,
  label: label(key),
  description: `Supplied ${label(key)}; preserve source method, site, period and context.`,
  group_key: Object.entries(inventory.measurement_groups).find(([, keys]) =>
    keys.includes(key),
  )![0],
  record_type: "measurement",
  logging_identifier: key,
  kind: studyKeys.includes(key)
    ? "study_summary"
    : key === "blood_pressure"
      ? "blood_pressure"
      : "scalar",
  recognized_units: units[key] ?? [],
  canonical_unit: units[key]?.[0] ?? null,
  allow_negative: signedKeys.has(key),
  result_variants: studyKeys.includes(key)
    ? []
    : key === "blood_pressure"
      ? ["quantity"]
      : key === "visual_acuity_snellen"
        ? ["ratio", "absent"]
        : ["quantity", "interval", "ratio", "ordinal", "absent"],
  required_context: requiredContexts[key] ?? [],
  required_context_paths: requiredContextPaths[key] ?? [],
  required_context_conditions: (requiredContextPaths[key] ?? []).map(
    (field_path) => ({
      field_path,
      when: { result_kind: { not: "absent" } },
    }),
  ),
  field_path:
    studyKeys.includes(key) || key === "blood_pressure" ? "" : "/value",
  value_field_paths: studyKeys.includes(key)
    ? [
        "/components",
        ...(key === "cgm_summary" ? ["/cgm"] : []),
        ...(key === "ambulatory_bp_summary" ? ["/ambulatory_bp"] : []),
      ]
    : key === "blood_pressure"
      ? ["/systolic", "/diastolic", "/pulse"]
      : ["/value"],
  component_keys: studyComponentKeys[key] ?? [],
  field_override_policy:
    "Existing indexed payload paths only; descendants inherit a parent override.",
  series_identity_dimensions: [
    "method",
    "unit",
    "body_region",
    "laterality",
    "body_position",
    "measurement_site",
    "specimen",
    "resting_state",
    "fasting_state",
    "meal_state",
    "hydration_context",
    "time_since_meal_minutes",
    "exercise_context",
    "oxygen_context",
    "temperature_site",
    "specimen_context",
    "device_context",
    "source_reference_range",
    "original_unit",
    "challenge_context",
    "reference_equation",
    "classification_metadata",
    "effective_period",
  ],
  trend_supported: key !== "blood_pressure",
  trend_key: `measurement:${key}`,
  aggregation:
    "last_usable_observation_per_local_day; interval studies stay individual",
  missing_context_policy: "unspecified remains its own series",
  normalization_policy:
    "No measurement conversion; supplied units are preserved and incompatible units remain separate series.",
  introduced_in: "1.0.0",
  deprecated: false,
  search_aliases: key === "weight" ? ["body mass"] : [],
}));
export const measurementByKey = new Map(
  measurementDefinitions.map((entry) => [entry.key, entry]),
);

const textAnalytes = new Set(
  "rbc_morphology wbc_morphology platelet_morphology peripheral_smear_findings hemoglobin_variant_identification ana_pattern anca_pattern red_cell_antibody_identification urine_color urine_clarity stool_ova_parasites semen_viscosity".split(
    " ",
  ),
);
const titerAnalytes = new Set(["ana_titer", "anca_titer", "rpr_titer"]);
const codedAnalytes = new Set(
  "blood_group_abo rhd_type red_cell_antibody_screen direct_antiglobulin_test hcg_qualitative ana_screen anca_screen urine_nitrite stool_occult_blood_guaiac fecal_fat_qualitative malaria_parasite_test".split(
    " ",
  ),
);
export const recognizedLabUnits: Record<string, string[]> = {
  hemoglobin: ["g/dL", "g/L"],
  hematocrit: ["%", "L/L"],
  wbc_count: ["10^9/L"],
  rbc_count: ["10^12/L"],
  platelet_count: ["10^9/L"],
  blood_glucose: ["mg/dL", "mmol/L"],
  hba1c: ["%", "mmol/mol"],
  sodium: ["mmol/L"],
  potassium: ["mmol/L"],
  chloride: ["mmol/L"],
  egfr: ["mL/min/1.73m2"],
  creatinine_clearance: ["mL/min"],
  lipoprotein_a_mass: ["mg/dL"],
  lipoprotein_a_molar: ["nmol/L"],
};
export const labDefinitions = inventory.lab_analytes.map((entry) => {
  const key = entry.analyte_key;
  const result_variants =
    key === "organism_culture_identification"
      ? ["culture_result", "absent"]
      : key === "antimicrobial_susceptibility"
        ? ["susceptibility_result", "absent"]
        : [
              "respiratory_pathogen_pcr",
              "gastrointestinal_pathogen_pcr",
              "pathogen_nucleic_acid",
            ].includes(key)
          ? ["pathogen_result", "absent"]
          : textAnalytes.has(key)
            ? ["text", "coded", "absent"]
            : titerAnalytes.has(key)
              ? ["titer", "absent"]
              : codedAnalytes.has(key) ||
                  entry.panel_keys.includes("infectious_serology")
                ? ["coded", "ordinal", "quantity", "interval", "absent"]
                : [
                    "quantity",
                    "interval",
                    "coded",
                    "ordinal",
                    "ratio",
                    "absent",
                  ];
  return {
    key,
    label: label(key),
    description: `Source-reported ${label(key)}; no inferred specimen, assay, reference interval or clinical interpretation.`,
    search_aliases:
      key === "hemoglobin"
        ? ["haemoglobin", "hb"]
        : key === "hba1c"
          ? ["glycated hemoglobin"]
          : [],
    record_type: "lab_result",
    panel_keys: entry.panel_keys,
    result_variants,
    recognized_units: recognizedLabUnits[key] ?? [],
    recognized_units_policy:
      "Per-key encoding hints only; an empty list means no unit hint is installed. All supplied units are preserved without normalization.",
    unit_policy:
      "Preserve reported units, including unfamiliar units. No automatic assay or lab unit conversion.",
    required_context: result_variants.includes("pathogen_result")
      ? ["result.organism_or_target"]
      : result_variants.includes("susceptibility_result")
        ? ["result.isolate_reference", "result.antimicrobial"]
        : [],
    series_identity_dimensions: [
      ...seriesIdentityFields,
      "result.unit",
      "result.organism_or_target",
      "result.isolate_reference",
      "result.antimicrobial",
      "collection_period",
    ],
    missing_context_policy:
      "Unspecified context remains a separate series; different custom identities never join implicitly.",
    normalization_policy: "none",
    external_codes: entry.external_codes,
    trend_supported: result_variants.includes("quantity"),
    trend_key: `lab:${key}`,
    source_status_policy:
      "Exclude preliminary/cancelled by default; unknown is not final but may be usable.",
    qualified_value_summary_policy:
      "Only equality quantities enter numeric means. Keep all other variants as annotated observations.",
    introduced_in: "1.0.0",
    deprecated: false,
  };
});
export const labByKey = new Map(
  labDefinitions.map((entry) => [entry.key, entry]),
);
export const labResultSchemas = {
  quantity,
  interval,
  coded,
  ordinal,
  ratio,
  titer,
  text: resultText,
  absent,
  pathogen_result: pathogenResult,
  culture_result: cultureResult,
  susceptibility_result: susceptibilityResult,
};
export const resultSchemaForLab = (key: string) => {
  const definitions = labByKey
    .get(key)!
    .result_variants.map(
      (kind) => labResultSchemas[kind as keyof typeof labResultSchemas],
    );
  return z.union(definitions);
};

export const nonAdditiveGroups = [
  ["energy_kcal", "energy_kj"],
  [
    "carbohydrate_g",
    "available_carbohydrate_g",
    "carbohydrate_by_difference_g",
    "fiber_g",
    "starch_g",
    "total_sugars_g",
    "total_sugar_alcohols_g",
  ],
  [
    "fat_g",
    "saturated_fat_g",
    "monounsaturated_fat_g",
    "polyunsaturated_fat_g",
    "omega_3_g",
    "omega_6_g",
  ],
  ["omega_3_g", "epa_dha_g", "ala_g", "epa_g", "dpa_n3_g", "dha_g"],
  ["lutein_zeaxanthin_ug", "lutein_ug", "zeaxanthin_ug"],
  ["bcaa_g", "leucine_g", "isoleucine_g", "valine_g"],
  [
    "choline_mg",
    "choline_free_mg",
    ...nutrientKeys.filter((key) => key.startsWith("choline_from_")),
  ],
  [
    "folate_ug",
    "folate_dfe_ug",
    "food_folate_ug",
    "folic_acid_ug",
    "five_mthf_ug",
  ],
  ["vitamin_a_rae_ug", "retinol_ug", "beta_carotene_ug"],
  ["vitamin_d_ug", "vitamin_d2_ug", "vitamin_d3_ug", "vitamin_d_25_oh_d3_ug"],
  ["vitamin_k_ug", "vitamin_k1_ug", "vitamin_k2_mk4_ug", "vitamin_k2_mk7_ug"],
  ["sodium_mg", "salt_g", "salt_equivalent_g"],
  [
    "total_sugars_g",
    "free_sugars_g",
    "added_sugars_g",
    "glucose_g",
    "fructose_g",
    "sucrose_g",
  ],
];
export const nutrientDefinitions = inventory.nutrient_entries.map((entry) => ({
  ...entry,
  label: label(entry.key),
  description: entry.notes,
  search_aliases: [],
  record_type: "nutrition",
  field_schema: entry.value_schema,
  required: false,
  nullable: true,
  applicable_variants: ["intake", "daily_total"],
  qualifier_support: ["exact", "bound", "interval", "unquantified"],
  quantity_kind: "consumed_amount",
  component_form: entry.key,
  expression_basis: "supplied_or_unknown",
  source_definition_refs: ["S01", "S03"],
  aggregation: "daily_total_precedence_else_known_intake_subtotal",
  aggregation_role: "individually_reported_component",
  non_additive_relationships: nonAdditiveGroups.filter((group) =>
    group.includes(entry.key),
  ),
  alternative_representation_of: entry.key.startsWith("energy_")
    ? "energy"
    : null,
  supplement_binding: `/nutrient_contributions/${entry.key}`,
  introduced_in: "1.0.0",
  deprecated: false,
  trend_supported: true,
  trend_key: `nutrient:${entry.key}`,
  series_identity_dimensions: [
    "component_details.expression_basis",
    "component_details.form",
    "component_details.method",
  ],
  qualified_value_summary_policy:
    "Qualified day totals override; bounds/intervals never enter exact sums.",
  normalization_policy: entry.key.startsWith("energy_")
    ? "1 kcal = 4.184 kJ; one representation per record"
    : "none",
}));
