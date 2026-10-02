import { z } from "zod";
import {
  analyteKeys,
  inventory,
  nutrientKeys,
  recordTypes,
  scalarKeys,
  studyKeys,
  measurementDefinitions,
  measurementByKey,
  labDefinitions,
  labByKey,
  labResultSchemas,
  studyComponentKeys,
} from "./definitions.js";
import * as p from "./primitives.js";

export const nutrients = z.strictObject(
  Object.fromEntries(
    nutrientKeys.map((key) => [key, p.nonnegative.nullable().optional()]),
  ),
);
export const nutrientQualifier = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("exact"),
    original_value_text: p.text(200).optional(),
    reported_precision: p.count.max(15).optional(),
  }),
  z.strictObject({
    kind: z.literal("bound"),
    comparator: z.enum(["lt", "le", "gt", "ge"]),
    original_value_text: p.text(200).optional(),
  }),
  z.strictObject({
    kind: z.literal("interval"),
    lower: p.nonnegative,
    upper: p.nonnegative,
    unit: p.text(80),
    lower_inclusive: z.boolean().optional(),
    upper_inclusive: z.boolean().optional(),
    original_value_text: p.text(200).optional(),
  }),
  z.strictObject({
    kind: z.literal("unquantified"),
    reason: p.absentReason,
    explanation: p.text(300).optional(),
    original_value_text: p.text(200).optional(),
  }),
]);
export const nutrientQualifiers = z.strictObject(
  Object.fromEntries(
    nutrientKeys.map((key) => [key, nutrientQualifier.optional()]),
  ),
);
export const componentDetail = z.strictObject({
  expression_basis: p.text(100).optional(),
  form: p.text(100).optional(),
  method: p.text(200).optional(),
  definition: p.text(300).optional(),
  definition_version: p.text(100).optional(),
  coverage: p.text(200).optional(),
  source_definition_reference: p.text(200).optional(),
});
export const componentDetails = z.strictObject(
  Object.fromEntries(
    nutrientKeys.map((key) => [key, componentDetail.optional()]),
  ),
);
const nutrientContext = {
  nutrient_qualifiers: nutrientQualifiers.optional(),
  component_details: componentDetails.optional(),
  quantity_basis: z.literal("total_for_logged_intake_or_day").optional(),
};
export const nutrition = z.strictObject({
  entry_kind: z.enum(["intake", "daily_total"]),
  label: p.text(200).optional(),
  nutrients,
  ...nutrientContext,
  energy_method: z
    .enum([
      "reported_unspecified",
      "atwater_general",
      "atwater_specific",
      "label_declared",
      "other",
    ])
    .optional(),
  carbohydrate_definition: p.text(200).optional(),
  fiber_method: p.text(200).optional(),
  folate_basis: p.text(200).optional(),
  vitamin_form_context: p.text(300).optional(),
  ...p.commonData,
});

const classificationMetadata = z.strictObject({
  frequency_hz: p.nonnegative.optional(),
  conduction: z.enum(["air", "bone", "unknown"]).optional(),
  masking: z.boolean().optional(),
  corrected_vision: z.boolean().optional(),
  viewing_distance: p.quantity.optional(),
  qt_correction_formula: p.text(100).optional(),
  lead: p.text(100).optional(),
  rhythm_context: p.text(200).optional(),
  beat_context: p.text(200).optional(),
  view: p.text(100).optional(),
  chamber: p.text(100).optional(),
  strain_convention: p.text(100).optional(),
  vertebral_levels_included: z.array(p.text(30)).max(20).optional(),
  vertebral_levels_excluded: z.array(p.text(30)).max(20).optional(),
  reference_database: p.text(200).optional(),
  comparison_information: p.text(300).optional(),
  precision_information: p.text(200).optional(),
  relaxed_flexed: z.enum(["relaxed", "flexed", "unknown"]).optional(),
  landmark: p.text(200).optional(),
  reading_sequence: p.count.optional(),
  cuff_size: p.text(100).optional(),
  rest_seconds: p.nonnegative.optional(),
  medication_timing: p.text(200).optional(),
  observation_window_seconds: p.nonnegative.optional(),
  recovery_kind: z.enum(["actual_heart_rate", "drop_from_peak"]).optional(),
  recovery_interval_seconds: p.nonnegative.optional(),
  recovery_mode: z.enum(["active", "passive", "unknown"]).optional(),
  bronchodilator_state: z.enum(["pre", "post", "none", "unknown"]).optional(),
  bronchodilator_agent: p.text(100).optional(),
  bronchodilator_dose: p.quantity.optional(),
  bronchodilator_elapsed_seconds: p.nonnegative.optional(),
  quality_grade: p.text(100).optional(),
  repeatability: p.text(200).optional(),
  dlco_corrections: z.array(p.text(100)).max(10).optional(),
  inspired_volume: p.quantity.optional(),
  protocol: p.text(200).optional(),
  test_duration_seconds: p.nonnegative.optional(),
  assistance: p.text(100).optional(),
  walking_aid: p.text(100).optional(),
  attempt_number: p.count.optional(),
});
const measurementContext = {
  uncertainty: p.uncertainty.optional(),
  specimen: p.specimenType.optional(),
  specimen_context: p.specimen.optional(),
  measurement_site: p.text(200).optional(),
  body_region: p.text(100).optional(),
  laterality: p.laterality.optional(),
  body_position: z
    .enum(["seated", "standing", "supine", "prone", "other", "unknown"])
    .optional(),
  method: p.methodContext.optional(),
  device_context: p.methodContext.optional(),
  resting_state: z
    .enum(["resting", "exercise", "recovery", "sleep", "unknown"])
    .optional(),
  fasting_state: z.enum(["fasting", "nonfasting", "unknown"]).optional(),
  meal_state: z
    .enum(["fasting", "random", "pre_meal", "post_meal", "unknown"])
    .optional(),
  time_since_meal_minutes: p.nonnegative.optional(),
  challenge_context: z
    .strictObject({
      label: p.text(200),
      dose: p.quantity.optional(),
      elapsed_seconds: p.nonnegative.optional(),
      procedure: p.text(200).optional(),
    })
    .optional(),
  hydration_context: p.text(200).optional(),
  exercise_context: p.text(200).optional(),
  oxygen_context: z
    .strictObject({
      support: z.enum(["room_air", "oxygen", "unknown"]),
      flow: p.quantity.optional(),
      fio2: p.quantity.optional(),
    })
    .optional(),
  temperature_site: p.text(100).optional(),
  source_reference_range: p.referenceRange.optional(),
  reported_predicted_value: p.quantity.optional(),
  reported_percent_predicted: p.nonnegative.optional(),
  reported_lower_limit_normal: p.quantity.optional(),
  reported_z_score: p.signed.optional(),
  reference_equation: p.methodContext.optional(),
  classification_metadata: classificationMetadata.optional(),
  source_status: p.sourceStatus.optional(),
  ...p.commonData,
};
const scalarValue = z.union([
  p.decimal,
  p.quantity,
  p.interval,
  p.ratio,
  p.ordinal,
  p.absent,
]);
const component = z.strictObject({
  value: scalarValue,
  unit: p.text(80).optional(),
  comparator: p.comparator.optional(),
  validity: p.validity.optional(),
  provenance: p.fieldOverride.optional(),
  context: z.strictObject(measurementContext).optional(),
});
export const components = z.strictObject(
  Object.fromEntries(scalarKeys.map((key) => [key, component.optional()])),
);
const cgm = z.strictObject({
  mean_glucose: p.quantity.optional(),
  median_glucose: p.quantity.optional(),
  standard_deviation: p.quantity.optional(),
  coefficient_of_variation_percent: p.nonnegative.optional(),
  reported_gmi_percent: p.nonnegative.optional(),
  glucose_unit: p.text(80).optional(),
  active_data_percent: p.percent.optional(),
  days_covered: p.nonnegative.optional(),
  bands: z.array(p.thresholdBand).max(20).optional(),
  event_counts: z
    .array(
      z.strictObject({
        label: p.text(100),
        count: p.count,
        definition: p.text(300),
      }),
    )
    .max(20)
    .optional(),
});
const bpSummary = z.strictObject({
  attempted_readings: p.count.optional(),
  valid_readings: p.count.optional(),
  daytime_definition: p.text(200).optional(),
  nighttime_definition: p.text(200).optional(),
  overall: z
    .strictObject({
      systolic: p.quantity.optional(),
      diastolic: p.quantity.optional(),
      pulse: p.quantity.optional(),
    })
    .optional(),
  day: z
    .strictObject({
      systolic: p.quantity.optional(),
      diastolic: p.quantity.optional(),
      pulse: p.quantity.optional(),
    })
    .optional(),
  night: z
    .strictObject({
      systolic: p.quantity.optional(),
      diastolic: p.quantity.optional(),
      pulse: p.quantity.optional(),
    })
    .optional(),
  dipping_percent: p.signed.optional(),
  calculation_basis: p.text(300).optional(),
});
export const measurement = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("scalar"),
    metric_key: z.enum(scalarKeys as [string, ...string[]]),
    value: scalarValue,
    unit: p.text(80).optional(),
    original_value: p.text(200).optional(),
    original_unit: p.text(80).optional(),
    comparator: p.comparator.optional(),
    ...measurementContext,
  }),
  z.strictObject({
    kind: z.literal("blood_pressure"),
    metric_key: z.literal("blood_pressure").optional(),
    systolic: p.decimal.or(p.quantity),
    diastolic: p.decimal.or(p.quantity),
    pulse: p.decimal.or(p.quantity).optional(),
    unit: z.enum(["mmHg", "kPa"]),
    ...measurementContext,
  }),
  z.strictObject({
    kind: z.literal("study_summary"),
    study_type: z.enum(studyKeys as [string, ...string[]]),
    components,
    effective_period: p.effectivePeriod,
    coverage: p.coverage.optional(),
    cgm: cgm.optional(),
    ambulatory_bp: bpSummary.optional(),
    ...measurementContext,
  }),
]);

export const drinkTypes = [
  "water",
  "sparkling_water",
  "tea",
  "coffee",
  "milk",
  "plant_milk",
  "juice",
  "soft_drink",
  "sports_drink",
  "oral_rehydration_drink",
  "soup_broth",
  "alcoholic_beverage",
  "other",
  "unspecified",
] as const;
const hydrationContext = {
  administration_route: z
    .enum(["oral", "enteral", "other", "unknown"])
    .optional(),
  description: p.text(200).optional(),
  ...p.commonData,
};
export const hydration = z.discriminatedUnion("entry_kind", [
  z.strictObject({
    entry_kind: z.literal("intake"),
    volume_ml: p.nonnegative,
    drink_type: z.enum(drinkTypes),
    ...hydrationContext,
  }),
  z.strictObject({
    entry_kind: z.literal("daily_total"),
    total_fluids_ml: p.nonnegative.nullable().optional(),
    water_ml: p.nonnegative.nullable().optional(),
    ...hydrationContext,
  }),
]);

const exertion = z.strictObject({
  scale: z.enum(["borg_6_20", "cr10", "reported_other"]),
  value: p.signed,
  lower: p.signed.optional(),
  upper: p.signed.optional(),
  meaning: p.text(200).optional(),
});
const activityMetrics = {
  elapsed_seconds: p.nonnegative.optional(),
  moving_seconds: p.nonnegative.optional(),
  paused_seconds: p.nonnegative.optional(),
  distance_m: p.nonnegative.optional(),
  steps: p.count.optional(),
  elevation_gain_m: p.nonnegative.optional(),
  elevation_loss_m: p.nonnegative.optional(),
  floors_ascended: p.nonnegative.optional(),
  floors_descended: p.nonnegative.optional(),
  average_speed_mps: p.nonnegative.optional(),
  max_speed_mps: p.nonnegative.optional(),
  average_pace_seconds_per_km: p.nonnegative.optional(),
  treadmill_incline_percent: p.signed.optional(),
  average_heart_rate_bpm: p.nonnegative.optional(),
  min_heart_rate_bpm: p.nonnegative.optional(),
  max_heart_rate_bpm: p.nonnegative.optional(),
  recovery_heart_rate_bpm: p.nonnegative.optional(),
  recovery_interval_seconds: p.nonnegative.optional(),
  energy_kcal: p.nonnegative.optional(),
  energy_basis: z.enum(["active", "gross", "unknown"]).optional(),
  average_power_w: p.nonnegative.optional(),
  max_power_w: p.nonnegative.optional(),
  reported_normalized_power_w: p.nonnegative.optional(),
  mechanical_work_kj: p.nonnegative.optional(),
  cadence: p.nonnegative.optional(),
  cadence_unit: z
    .enum([
      "steps_per_minute",
      "strides_per_minute",
      "revolutions_per_minute",
      "strokes_per_minute",
    ])
    .optional(),
  stride_length_m: p.nonnegative.optional(),
  ground_contact_time_ms: p.nonnegative.optional(),
  vertical_oscillation_cm: p.nonnegative.optional(),
  vertical_ratio_percent: p.nonnegative.optional(),
  ground_contact_balance_percent: p.percent.optional(),
};
const trainingContext = z.strictObject({
  surface: p.text(100).optional(),
  environment: z.enum(["indoor", "outdoor", "unknown"]).optional(),
  altitude_m: p.signed.optional(),
  heart_rate_context: p.text(200).optional(),
  ground_contact_balance_side: p.laterality.optional(),
  ground_contact_balance_reference: p.text(200).optional(),
  floors_definition: p.text(200).optional(),
  source_precision: p.text(100).optional(),
});
const segment = z.strictObject({
  index: p.count,
  type: z.enum(["lap", "work", "recovery", "warmup", "cooldown", "other"]),
  start_at: p.instant.optional(),
  end_at: p.instant.optional(),
  elapsed_offset_seconds: p.nonnegative.optional(),
  ...activityMetrics,
  source_precision: p.text(100).optional(),
  coverage: p.coverage.optional(),
  overlap_note: p.text(200).optional(),
});
const rowing = z.strictObject({
  stroke_count: p.count.optional(),
  stroke_rate_per_minute: p.nonnegative.optional(),
  distance_m: p.nonnegative.optional(),
  stroke_length_m: p.nonnegative.optional(),
  drag_factor: p.nonnegative.optional(),
  resistance_level: p.signed.optional(),
  resistance_definition: p.text(200).optional(),
});
const swimming = z.strictObject({
  pool_length: p.quantity.optional(),
  count: p.count.optional(),
  count_meaning: z.enum(["laps", "lengths"]).optional(),
  stroke_type: p.text(100).optional(),
  stroke_count: p.count.optional(),
  stroke_rate_per_minute: p.nonnegative.optional(),
  open_water: z.boolean().optional(),
  reported_swolf: p.nonnegative.optional(),
  swolf_interval_seconds: p.nonnegative.optional(),
  swolf_pool_length: p.quantity.optional(),
});
const strengthSet = z.strictObject({
  exercise_name: p.text(200),
  set_index: p.count,
  designation: z
    .enum(["warmup", "working", "drop", "other", "unknown"])
    .optional(),
  repetitions: p.count,
  load: p.quantity.optional(),
  load_interpretation: z.enum([
    "total",
    "per_hand",
    "per_side",
    "machine_stack",
    "bodyweight",
    "assistance",
    "unknown",
  ]),
  laterality: p.laterality.optional(),
  duration_seconds: p.nonnegative.optional(),
  rest_seconds: p.nonnegative.optional(),
  tempo: p.text(100).optional(),
  exertion: exertion.optional(),
  repetitions_in_reserve: p.nonnegative.optional(),
});
const dailyActivity = z.strictObject({
  steps: p.count.optional(),
  distance_m: p.nonnegative.optional(),
  active_energy_kcal: p.nonnegative.optional(),
  resting_energy_kcal: p.nonnegative.optional(),
  total_energy_kcal: p.nonnegative.optional(),
  exercise_seconds: p.nonnegative.optional(),
  standing_seconds: p.nonnegative.optional(),
  sedentary_seconds: p.nonnegative.optional(),
  moderate_seconds: p.nonnegative.optional(),
  vigorous_seconds: p.nonnegative.optional(),
  light_seconds: p.nonnegative.optional(),
  definitions: p.text(300).optional(),
  coverage: p.coverage.optional(),
});
export const activity = z.discriminatedUnion("entry_kind", [
  z.strictObject({
    entry_kind: z.literal("workout"),
    activity_type: z.enum([
      "walking",
      "running",
      "cycling",
      "swimming",
      "rowing",
      "strength_training",
      "yoga",
      "hiking",
      "stair_climbing",
      "treadmill_incline_walk",
      "stationary_cycling",
      "indoor_rowing",
      "resistance_training",
      "pilates",
      "dance",
      "team_sport",
      "racket_sport",
      "other",
    ]),
    activity_label: p.text(200).optional(),
    start_at: p.instant.optional(),
    end_at: p.instant.optional(),
    ...activityMetrics,
    training_context: trainingContext.optional(),
    exertion: exertion.optional(),
    heart_rate_zones: z.array(p.thresholdBand).max(20).optional(),
    power_zones: z.array(p.thresholdBand).max(20).optional(),
    segments: z.array(segment).max(100).optional(),
    rowing: rowing.optional(),
    swimming: swimming.optional(),
    strength: z.array(strengthSet).max(100).optional(),
    ...p.commonData,
  }),
  z.strictObject({
    entry_kind: z.literal("daily_total"),
    daily_totals: dailyActivity,
    ...p.commonData,
  }),
]);

const respiratoryIndex = z.strictObject({
  value: p.nonnegative,
  denominator: z.enum(["sleep_hours", "monitoring_hours", "unknown"]),
  duration_seconds: p.nonnegative.optional(),
  definition: p.text(300).optional(),
});
const respiratoryEvents = z.strictObject({
  ahi: respiratoryIndex.optional(),
  rei: respiratoryIndex.optional(),
  rdi: respiratoryIndex.optional(),
  obstructive_apnea_index: respiratoryIndex.optional(),
  central_apnea_index: respiratoryIndex.optional(),
  mixed_apnea_index: respiratoryIndex.optional(),
  hypopnea_index: respiratoryIndex.optional(),
  rera_index: respiratoryIndex.optional(),
  apnea_count: p.count.optional(),
  hypopnea_count: p.count.optional(),
  rera_count: p.count.optional(),
  rem: respiratoryIndex.optional(),
  non_rem: respiratoryIndex.optional(),
  supine: respiratoryIndex.optional(),
  non_supine: respiratoryIndex.optional(),
});
const oxygenSummary = z.strictObject({
  mean_percent: p.percent.optional(),
  nadir_percent: p.percent.optional(),
  max_percent: p.percent.optional(),
  desaturation_index: respiratoryIndex.optional(),
  desaturation_definition: p.text(300).optional(),
  desaturation_count: p.count.optional(),
  desaturation_duration_seconds: p.nonnegative.optional(),
  time_below_threshold: z.array(p.thresholdBand).max(20).optional(),
});
const sleepStudy = z.strictObject({
  study_type: z.enum([
    "psg",
    "home_sleep_test",
    "device_session",
    "reported_other",
    "unknown",
  ]),
  effective_period: p.effectivePeriod.optional(),
  recording_seconds: p.nonnegative.optional(),
  monitoring_seconds: p.nonnegative.optional(),
  estimated_sleep_seconds: p.nonnegative.optional(),
  usable_seconds: p.nonnegative.optional(),
  scoring_rule: p.text(200).optional(),
  scoring_version: p.text(100).optional(),
  context: p.text(300).optional(),
  coverage: p.coverage.optional(),
});
const papSession = z.strictObject({
  mode: p.text(100).optional(),
  pressure: p.quantity.optional(),
  use_seconds: p.nonnegative.optional(),
  residual_indices: respiratoryEvents.optional(),
  leak: z
    .strictObject({
      value: p.nonnegative,
      unit: p.text(80),
      basis: z.enum(["mean", "median", "percentile", "other", "unknown"]),
      percentile: p.percent.optional(),
      definition: p.text(200).optional(),
    })
    .optional(),
  mask_off_seconds: p.nonnegative.optional(),
  large_leak_seconds: p.nonnegative.optional(),
});
export const sleep = z.strictObject({
  entry_kind: z.enum(["session", "study_summary"]),
  session_type: z.enum(["main", "nap", "unknown"]),
  start_at: p.instant.optional(),
  end_at: p.instant.optional(),
  time_in_bed_seconds: p.nonnegative.optional(),
  sleep_seconds: p.nonnegative.optional(),
  sleep_latency_seconds: p.nonnegative.optional(),
  rem_latency_seconds: p.nonnegative.optional(),
  waso_seconds: p.nonnegative.optional(),
  awake_seconds: p.nonnegative.optional(),
  awakenings: p.count.optional(),
  sleep_efficiency_percent: p.percent.optional(),
  stage_durations: z
    .strictObject(
      Object.fromEntries(
        [
          "n1",
          "n2",
          "n3",
          "rem",
          "awake",
          "unclassified",
          "light",
          "deep",
          "core",
        ].map((key) => [key, p.nonnegative.optional()]),
      ),
    )
    .optional(),
  stage_system: p.text(100).optional(),
  stage_intervals: z
    .array(
      z.strictObject({
        stage: p.text(100),
        start_at: p.instant,
        end_at: p.instant,
      }),
    )
    .max(200)
    .optional(),
  quality: p.reportedScore.optional(),
  device_sleep_score: p.reportedScore.optional(),
  snoring: z.boolean().nullable().optional(),
  breathing_interruptions: z.boolean().nullable().optional(),
  awakening_symptoms: z.array(p.text(200)).max(20).optional(),
  perceived_restfulness: p.reportedScore.optional(),
  heart_rate_summary: p.scalarSummary.optional(),
  respiratory_rate_summary: p.scalarSummary.optional(),
  oxygen_summary: oxygenSummary.optional(),
  study_metadata: sleepStudy.optional(),
  respiratory_events: respiratoryEvents.optional(),
  arousals: z
    .strictObject({
      count: p.count.optional(),
      index: respiratoryIndex.optional(),
      respiratory_related_index: respiratoryIndex.optional(),
      rule: p.text(200).optional(),
    })
    .optional(),
  limb_movements: z
    .strictObject({
      count: p.count.optional(),
      index: respiratoryIndex.optional(),
      movement_related_arousal_index: respiratoryIndex.optional(),
      rule: p.text(200).optional(),
    })
    .optional(),
  body_position_summary: z
    .array(
      z.strictObject({
        position: p.text(100),
        duration_seconds: p.nonnegative.optional(),
        respiratory_index: respiratoryIndex.optional(),
      }),
    )
    .max(10)
    .optional(),
  pap_session: papSession.optional(),
  recorded_environment: z
    .strictObject({
      noise: p.text(100).optional(),
      temperature: p.quantity.optional(),
      location_label: p.text(100).optional(),
    })
    .optional(),
  ...p.commonData,
});

const symptom = z.strictObject({
  name: p.text(100),
  description: p.text(300).optional(),
  body_site: p.text(100).optional(),
  laterality: p.laterality.optional(),
  onset: p.date.or(p.instant).optional(),
  onset_precision: z.enum(["date", "instant", "unknown"]).optional(),
  duration_seconds: p.nonnegative.optional(),
  frequency: p.text(100).optional(),
  severity: p.reportedScore.optional(),
  course: z
    .enum(["new", "improving", "unchanged", "worsening", "resolved", "unknown"])
    .optional(),
  triggers: z.array(p.text(100)).max(10).optional(),
  relievers: z.array(p.text(100)).max(10).optional(),
  associated_symptoms: z.array(p.text(100)).max(20).optional(),
  function_effect: p.text(300).optional(),
});
export const completeness = z.enum([
  "unknown",
  "partial",
  "complete",
  "not_tracked",
]);
export const checkin = z.strictObject({
  ratings: z
    .strictObject(
      Object.fromEntries(
        [
          "energy",
          "fatigue",
          "hunger",
          "satiety",
          "thirst",
          "stress",
          "soreness",
          "pain",
          "sleepiness",
          "concentration",
          "motivation",
          "perceived_recovery",
          "mood",
        ].map((key) => [key, p.reportedScore.optional()]),
      ),
    )
    .optional(),
  symptoms: z.array(symptom).max(30).optional(),
  diary_completeness: z
    .strictObject({
      ...Object.fromEntries(
        recordTypes.map((key) => [key, completeness.optional()]),
      ),
      reported_at: p.instant,
    })
    .optional(),
  gastrointestinal: z
    .strictObject({
      bowel_movement_count: p.count.optional(),
      bristol_type: p.count.min(1).max(7).optional(),
      consistency: p.text(100).optional(),
      ...Object.fromEntries(
        [
          "urgency",
          "constipation",
          "diarrhea",
          "nausea",
          "vomiting",
          "reflux",
          "bloating",
          "blood",
          "mucus",
        ].map((key) => [key, z.boolean().nullable().optional()]),
      ),
      context: p.text(200).optional(),
    })
    .optional(),
  urinary: z
    .strictObject({
      void_count: p.count.optional(),
      nocturia_count: p.count.optional(),
      urgency: z.boolean().nullable().optional(),
      pain_burning: z.boolean().nullable().optional(),
      visible_blood: z.boolean().nullable().optional(),
      measured_volume_ml: p.nonnegative.optional(),
      collection_duration_seconds: p.nonnegative.optional(),
      context: p.text(200).optional(),
    })
    .optional(),
  reproductive: z
    .strictObject({
      bleeding_amount: p.reportedScore.optional(),
      spotting_amount: p.reportedScore.optional(),
      cycle_day: p.count.optional(),
      period_start: p.date.optional(),
      period_end: p.date.optional(),
      pregnancy_test_record_id: z.uuid().optional(),
      gestational_context: p.text(200).optional(),
    })
    .optional(),
  assessment_results: z
    .array(
      z.strictObject({
        instrument: p.text(100),
        version: p.text(100).optional(),
        score: p.reportedScore,
        date: p.date,
        completion_status: z.enum(["completed", "partial", "unknown"]),
        items: z
          .array(
            z.strictObject({ identifier: p.text(100), result: p.resultValue }),
          )
          .max(50)
          .optional(),
      }),
    )
    .max(20)
    .optional(),
  actual_fasting_interval: p.effectivePeriod.optional(),
  pain_function_context: p.text(300).optional(),
  ...p.commonData,
});

const ingredient = z.strictObject({
  compound_name: p.text(200),
  chemical_form: p.text(200).optional(),
  compound_mass: p.quantity.optional(),
  active_moiety_amount: p.quantity.optional(),
  elemental_amount: p.quantity.optional(),
  strength: z
    .strictObject({
      numerator: p.quantity,
      denominator: p.quantity,
      basis: z.enum([
        "per_tablet",
        "per_capsule",
        "per_ml",
        "per_g",
        "per_dose",
        "other",
        "unknown",
      ]),
    })
    .optional(),
});
export const intake = z.strictObject({
  product_name: p.text(200),
  category: z.enum(["supplement", "medication", "other"]),
  product_type: z
    .enum([
      "tablet",
      "capsule",
      "powder",
      "liquid",
      "injection",
      "patch",
      "inhaled",
      "topical",
      "vaccine",
      "other",
      "unknown",
    ])
    .optional(),
  status: z.enum(["taken", "missed", "skipped", "partially_taken"]),
  administered_quantity: p.quantity.nullable().optional(),
  dosage_form: p.text(200).optional(),
  ingredients: z.array(ingredient).max(50).optional(),
  route: p.text(100).optional(),
  site: p.text(100).optional(),
  start_at: p.instant.optional(),
  end_at: p.instant.optional(),
  duration_seconds: p.nonnegative.optional(),
  effective_period: p.effectivePeriod.optional(),
  administered_volume_ml: p.nonnegative.optional(),
  administration_rate: p.quantity.optional(),
  taken_with_food: z.boolean().nullable().optional(),
  source_intake_reason: p.text(300).optional(),
  missed_skipped_reason: p.text(300).optional(),
  nutrient_contributions: nutrients.optional(),
  ...nutrientContext,
  reported_reaction: symptom.optional(),
  ...p.commonData,
});

const labCommon = {
  original_analyte_name: p.text(200).optional(),
  external_codes: p.codes.optional(),
  result: p.resultValue,
  original_result_text: p.text(500).optional(),
  unit: p.text(80).optional(),
  original_unit: p.text(80).optional(),
  source_status: p.sourceStatus.optional(),
  data_absent_reason: p.absentReason.optional(),
  specimen: p.specimen.optional(),
  collection_period: p.effectivePeriod.optional(),
  collected_on: p.date.optional(),
  collected_at: p.instant.optional(),
  received_at: p.instant.optional(),
  received_on: p.date.optional(),
  analyzed_at: p.instant.optional(),
  analyzed_on: p.date.optional(),
  reported_on: p.date.optional(),
  reported_at: p.instant.optional(),
  original_date_notes: p.text(300).optional(),
  laboratory: p.text(200).optional(),
  laboratory_site: p.text(200).optional(),
  collection_clock_time: z.iso.time().optional(),
  method: p.methodContext.optional(),
  instrument: p.text(200).optional(),
  assay_version: p.text(100).optional(),
  detection_limit: p.quantity.optional(),
  quantification_limit: p.quantity.optional(),
  reference_ranges: z.array(p.referenceRange).max(10).optional(),
  source_flags: z.array(p.text(100)).max(20).optional(),
  source_interpretation: p.text(500).optional(),
  fasting_context: z
    .strictObject({
      status: z.enum(["fasting", "nonfasting", "unknown"]),
      duration_seconds: p.nonnegative.optional(),
    })
    .optional(),
  challenge_context: z
    .strictObject({
      label: p.text(200),
      dose: p.quantity.optional(),
      elapsed_seconds: p.nonnegative.optional(),
      procedure: p.text(200).optional(),
    })
    .optional(),
  sampling_context: z
    .strictObject({
      designation: z.enum(["peak", "trough", "random", "unknown"]),
      last_dose_at: p.instant.optional(),
      elapsed_seconds: p.nonnegative.optional(),
      dose: p.quantity.optional(),
      route: p.text(100).optional(),
    })
    .optional(),
  quantity_context: z
    .strictObject({
      property: p.text(100).optional(),
      equation: p.text(200).optional(),
      equation_version: p.text(100).optional(),
      marker_basis: p.text(100).optional(),
      bsa_normalization: z
        .enum(["indexed_1_73_m2", "absolute", "unknown"])
        .optional(),
      reporting_convention: p.text(100).optional(),
      ldl_method: z.enum(["direct", "calculated", "unknown"]).optional(),
      calculation_inputs: z.array(z.uuid()).max(20).optional(),
      target_identity: p.text(200).optional(),
      effective_duration_seconds: p.nonnegative.optional(),
      assay_basis: p.text(100).optional(),
    })
    .optional(),
  report_reference: p.text(200).optional(),
  report_revision: p.text(100).optional(),
  original_panel_label: p.text(200).optional(),
  panel_keys: z
    .array(
      z.enum(
        inventory.lab_panels.map((entry) => entry.panel_key) as [
          string,
          ...string[],
        ],
      ),
    )
    .max(30)
    .optional(),
  specimen_reference: p.text(200).optional(),
  related_result_ids: z.array(z.uuid()).max(30).optional(),
  source_reference: p.text(200).optional(),
  ...p.commonData,
};
export const labResult = z.discriminatedUnion("analyte_kind", [
  z.strictObject({
    analyte_kind: z.literal("builtin"),
    analyte_key: z.enum(analyteKeys as [string, ...string[]]),
    ...labCommon,
  }),
  z.strictObject({
    analyte_kind: z.literal("custom"),
    analyte_key: z.null(),
    ...labCommon,
    original_analyte_name: p.text(200),
    custom_identity: p.text(100).optional(),
  }),
]);
export const recordSchemas = {
  measurement,
  nutrition,
  hydration,
  activity,
  sleep,
  checkin,
  intake,
  lab_result: labResult,
};
export const dataUnion = z.union(Object.values(recordSchemas));

const nonnegativeDecimal = z.union([
  p.nonnegative,
  z
    .string()
    .max(80)
    .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/),
]);
const percentageDecimal = z.union([
  p.percent,
  z
    .string()
    .max(80)
    .regex(/^(?:(?:0|[1-9]\d?)(?:\.\d+)?|100(?:\.0+)?)$/),
]);
function nonempty<T>(values: T[]): [T, ...T[]] {
  const first = values[0];
  if (!first) throw new Error("Registry branches cannot be empty");
  return [first, ...values.slice(1)];
}
const contextCache = new Map<string, z.ZodObject>();
function scalarContext(key: string, required: boolean): z.ZodObject {
  const paths = required
    ? measurementByKey.get(key)!.required_context_paths
    : [];
  const identity = JSON.stringify(paths);
  const cached = contextCache.get(identity);
  if (cached) return cached;
  const shape: Record<string, z.ZodType> = { ...measurementContext };
  const classification: Record<string, z.ZodType> = {
    ...classificationMetadata.shape,
  };
  for (const path of paths) {
    const [, field, nested] = path.split("/");
    if (nested) {
      classification[nested] = (
        classification[nested] as z.ZodOptional<z.ZodType>
      ).unwrap();
      shape[field!] = z.strictObject(classification);
    } else shape[field!] = (shape[field!] as z.ZodOptional<z.ZodType>).unwrap();
  }
  const schema = z.strictObject(shape);
  contextCache.set(identity, schema);
  return schema;
}
const scalarValueCache = new Map<string, z.ZodType>();
function scalarInputValue(key: string, innerUnit: boolean): z.ZodType {
  const definition = measurementByKey.get(key)!;
  const policy = JSON.stringify({
    units: definition.recognized_units,
    negative: definition.allow_negative,
    percent:
      definition.recognized_units.includes("%") &&
      key !== "global_longitudinal_strain",
    variants: definition.result_variants,
    innerUnit,
  });
  const cached = scalarValueCache.get(policy);
  if (cached) return cached;
  const unit = z.enum(definition.recognized_units as [string, ...string[]]);
  const amount = definition.allow_negative
    ? p.decimal
    : definition.recognized_units.every((value) => value === "%")
      ? percentageDecimal
      : nonnegativeDecimal;
  const variants: z.ZodType[] = [];
  if (!innerUnit && definition.result_variants.includes("quantity"))
    variants.push(amount);
  for (const kind of definition.result_variants) {
    if (kind === "quantity")
      variants.push(
        p.quantity.extend({
          value: amount,
          unit: innerUnit ? unit : unit.optional(),
        }),
      );
    else if (kind === "interval")
      variants.push(
        p.interval.extend({
          lower: amount,
          upper: amount,
          unit: innerUnit ? unit : unit.optional(),
        }),
      );
    else if (kind !== "absent")
      variants.push(labResultSchemas[kind as keyof typeof labResultSchemas]);
  }
  const schema = variants.length === 1 ? variants[0]! : z.union(variants);
  scalarValueCache.set(policy, schema);
  return schema;
}
const scalarPolicies = new Map<string, string[]>();
for (const definition of measurementDefinitions.filter(
  (entry) => entry.kind === "scalar",
)) {
  const policy = JSON.stringify({
    units: definition.recognized_units,
    negative: definition.allow_negative,
    percent: definition.key === "global_longitudinal_strain",
    variants: definition.result_variants,
    context: definition.required_context_paths,
  });
  const keys = scalarPolicies.get(policy) ?? [];
  keys.push(definition.key);
  scalarPolicies.set(policy, keys);
}
function scalarBranches(innerUnit: boolean) {
  return [...scalarPolicies.values()].map((keys) => {
    const key = keys[0]!;
    const definition = measurementByKey.get(key)!;
    const unit = z.enum(definition.recognized_units as [string, ...string[]]);
    return z.strictObject({
      ...scalarContext(key, true).shape,
      kind: z.literal("scalar"),
      metric_key: z.enum(keys as [string, ...string[]]),
      value: scalarInputValue(key, innerUnit),
      unit: innerUnit ? unit.optional() : unit,
      original_value: p.text(200).optional(),
      original_unit: p.text(80).optional(),
      comparator: p.comparator.optional(),
    });
  });
}
const componentInputCache = new Map<string, z.ZodType>();
function componentInput(key: string): z.ZodType {
  const definition = measurementByKey.get(key)!;
  const policy = JSON.stringify({
    units: definition.recognized_units,
    negative: definition.allow_negative,
    variants: definition.result_variants,
    context: definition.required_context_paths,
  });
  const cached = componentInputCache.get(policy);
  if (cached) return cached;
  const unit = z.enum(definition.recognized_units as [string, ...string[]]);
  const context = scalarContext(key, true);
  const fields = {
    comparator: p.comparator.optional(),
    validity: p.validity.optional(),
    provenance: p.fieldOverride.optional(),
    context: definition.required_context_paths.length
      ? context
      : context.optional(),
  };
  const schema = z.union([
    z.strictObject({
      ...fields,
      value: scalarInputValue(key, false),
      unit,
    }),
    z.strictObject({
      ...fields,
      value: scalarInputValue(key, true),
      unit: unit.optional(),
    }),
    z.strictObject({
      ...fields,
      value: p.absent,
      unit: unit.optional(),
      context: scalarContext(key, false).optional(),
    }),
  ]);
  componentInputCache.set(policy, schema);
  return schema;
}
const studyInput = z.discriminatedUnion(
  "study_type",
  nonempty(
    studyKeys.map((key) =>
      z.strictObject({
        ...measurementContext,
        kind: z.literal("study_summary"),
        study_type: z.literal(key),
        components: z.strictObject(
          Object.fromEntries(
            studyComponentKeys[key]!.map((componentKey) => [
              componentKey,
              componentInput(componentKey).optional(),
            ]),
          ),
        ),
        effective_period: p.effectivePeriod,
        coverage: p.coverage.optional(),
        ...(key === "cgm_summary" ? { cgm: cgm.optional() } : {}),
        ...(key === "ambulatory_bp_summary"
          ? { ambulatory_bp: bpSummary.optional() }
          : {}),
      }),
    ),
  ),
);
const bloodPressureInput = z.strictObject({
  ...measurementContext,
  kind: z.literal("blood_pressure"),
  metric_key: z.literal("blood_pressure").optional(),
  systolic: nonnegativeDecimal.or(
    p.quantity.extend({
      value: nonnegativeDecimal,
      unit: z.enum(["mmHg", "kPa"]).optional(),
    }),
  ),
  diastolic: nonnegativeDecimal.or(
    p.quantity.extend({
      value: nonnegativeDecimal,
      unit: z.enum(["mmHg", "kPa"]).optional(),
    }),
  ),
  pulse: nonnegativeDecimal
    .or(
      p.quantity.extend({
        value: nonnegativeDecimal,
        unit: z.literal("bpm").optional(),
      }),
    )
    .optional(),
  unit: z.enum(["mmHg", "kPa"]),
});
export const measurementInput = z.union([
  z.discriminatedUnion("metric_key", nonempty(scalarBranches(false))),
  z.discriminatedUnion("metric_key", nonempty(scalarBranches(true))),
  z.strictObject({
    ...measurementContext,
    kind: z.literal("scalar"),
    metric_key: z.enum(scalarKeys as [string, ...string[]]),
    value: p.absent,
    unit: p.text(80).optional(),
    original_value: p.text(200).optional(),
    original_unit: p.text(80).optional(),
  }),
  bloodPressureInput,
  studyInput,
]);
const labPolicies = new Map<string, string[]>();
for (const definition of labDefinitions) {
  const policy = JSON.stringify(definition.result_variants);
  const keys = labPolicies.get(policy) ?? [];
  keys.push(definition.key);
  labPolicies.set(policy, keys);
}
const laboratoryValueCache = new Map<string, z.ZodType>();
function laboratoryInputValue(
  variants: string[],
  innerUnit: boolean,
): z.ZodType {
  const policy = JSON.stringify({ variants, innerUnit });
  const cached = laboratoryValueCache.get(policy);
  if (cached) return cached;
  const values = variants.map((kind) => {
    if (kind === "quantity")
      return p.quantity.extend({
        unit: innerUnit ? p.text(80) : p.text(80).optional(),
      });
    if (kind === "interval")
      return p.interval.extend({
        unit: innerUnit ? p.text(80) : p.text(80).optional(),
      });
    if (kind === "pathogen_result")
      return p.pathogenResult.extend({
        result: z.discriminatedUnion("kind", [
          p.quantity.extend({
            unit: innerUnit ? p.text(80) : p.text(80).optional(),
          }),
          p.coded,
          p.absent,
        ]),
      });
    if (kind === "culture_result")
      return p.cultureResult.extend({
        isolates: z
          .array(
            z.strictObject({
              isolate_label: p.text(100),
              organism: p.text(200),
              quantity: p.quantity
                .extend({
                  unit: innerUnit ? p.text(80) : p.text(80).optional(),
                })
                .optional(),
            }),
          )
          .max(20),
      });
    if (kind === "susceptibility_result")
      return p.susceptibilityResult.extend({
        mic: p.quantity
          .extend({
            unit: innerUnit ? p.text(80) : p.text(80).optional(),
          })
          .optional(),
        disk_zone: p.quantity
          .extend({
            value: nonnegativeDecimal,
            unit: innerUnit ? p.text(80) : p.text(80).optional(),
          })
          .optional(),
      });
    return labResultSchemas[kind as keyof typeof labResultSchemas];
  });
  const schema = values.length === 1 ? values[0]! : z.union(values);
  laboratoryValueCache.set(policy, schema);
  return schema;
}
function builtinLabBranches(innerUnit: boolean) {
  return [...labPolicies.values()].map((keys) =>
    z.strictObject({
      ...labCommon,
      analyte_kind: z.literal("builtin"),
      analyte_key: z.enum(keys as [string, ...string[]]),
      result: laboratoryInputValue(
        labByKey.get(keys[0]!)!.result_variants,
        innerUnit,
      ),
      unit: innerUnit ? p.text(80).optional() : p.text(80),
    }),
  );
}
const customLabInput = (innerUnit: boolean) =>
  z.strictObject({
    ...labCommon,
    analyte_kind: z.literal("custom"),
    analyte_key: z.null(),
    original_analyte_name: p.text(200),
    custom_identity: p.text(100).optional(),
    result: laboratoryInputValue(Object.keys(labResultSchemas), innerUnit),
    unit: innerUnit ? p.text(80).optional() : p.text(80),
  });
export const labResultInput = z.union([
  z.discriminatedUnion("analyte_key", nonempty(builtinLabBranches(false))),
  z.discriminatedUnion("analyte_key", nonempty(builtinLabBranches(true))),
  customLabInput(false),
  customLabInput(true),
]);
export const recordInputSchemas = {
  ...recordSchemas,
  measurement: measurementInput,
  lab_result: labResultInput,
};
export const commonEnvelope = {
  occurred_on: p.date.nullable().optional(),
  occurred_at: p.instant.nullable().optional(),
  ended_at: p.instant.nullable().optional(),
  timezone: p.text(100).optional(),
  time_precision: z.enum(["date", "instant", "period", "unknown"]).optional(),
  date_basis: z
    .enum([
      "reported_date",
      "event_date",
      "wake_date",
      "specimen_date",
      "report_date",
      "unknown",
    ])
    .optional(),
  provenance: p.provenance,
  validity: p.validity.optional(),
};
const inputFor = <T extends z.ZodType>(data: T) =>
  z.strictObject({ ...commonEnvelope, occurred_on: p.date, data });
export const recordInputs = {
  measurement: inputFor(measurementInput),
  nutrition: inputFor(nutrition),
  hydration: inputFor(hydration),
  activity: inputFor(activity),
  sleep: inputFor(sleep),
  checkin: inputFor(checkin),
  intake: inputFor(intake),
  lab_result: z.strictObject({ ...commonEnvelope, data: labResultInput }),
};
