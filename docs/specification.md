# Personal Health Ledger — complete API + MCP implementation specification

Revision 5 • Consolidated single-file edition • 2 October 2026

Implement a single-user structured health datastore with equivalent REST API and MCP capabilities. This specification is independent of any particular client or harness. The names below are proposed application contracts.


### Revision 5 coverage

This research-backed revision specifies **182 nutrient/food-component keys**, **424 unique built-in laboratory analyte keys across 30 discovery groups**, and **110 measurement/study keys**. It keeps eight record types, sixteen MCP tools, one service, one database, static `AUTH_KEY` authentication and the original exclusions. Counts describe this proposed implementation inventory, not tests performed on a person or a live service's current capabilities.

This document contains the complete implementation requirements, research references, acceptance criteria, and field inventory. Use [Appendix A — Embedded field inventory](#appendix-a--embedded-field-inventory) for exact identifiers and memberships, and the numbered sections for complete semantics. No separate inventory file is required. The field inventory is not a complete generated runtime schema. Preserve v4 identifiers and examples; implement new value/context semantics through documented schema versions rather than silently rewriting historical data.

## 1. Mission and service boundary

Act as a senior backend engineer. Build a small, reliable, single-user health datastore with a versioned REST API and ONE Model Context Protocol (MCP) endpoint.

Both interfaces accept structured records and expose the same authentication, machine-readable capability discovery, strict validation, durable storage, correction, retrieval, and deterministic-summary capabilities. The service is independent of any specific client, agent, or harness.

Store supplied observations and events, including explicitly labelled estimates. Preserve dates, units, provenance, uncertainty, and revision history. Do not generate health observations, infer missing values, provide diagnoses, or manage health targets.

Implement working code, migrations, tests, OpenAPI documentation, MCP tools, deployment configuration, and an operator README. Do not stop at an architecture proposal. Document the interfaces and test results without assuming a particular downstream application.

```text
MCP clients / harnesses --> MCP /mcp ----+
                                       |
                                       +--> Shared domain services --> PostgreSQL
                                       |
REST clients -----------> REST /v1/* ---+
```

## 2. Scope and implementation choices

Use one service and one database. Prefer TypeScript, a supported Node.js LTS release, PostgreSQL, and the official TypeScript MCP SDK. Reuse the repository's equivalent backend framework, validation library, and migration tooling where already present. Otherwise choose a small conventional stack and pin the dependency versions actually tested.

Serve remote MCP using Streamable HTTP at `/mcp`; use the official SDK rather than implementing JSON-RPC and protocol negotiation from scratch. Implement the HTTP methods, negotiation, and error behavior required by the chosen SDK. Do not invent an MCP method per REST route.

### Explicit exclusions

Do not build any application UI, dashboard, authentication screen, admin panel, review screen, widget, frontend bundle, or interactive Swagger UI. An OpenAPI JSON document is sufficient.

Do not build OAuth, account registration, user management, tenants, organizations, roles, scopes, per-user API keys, key-generation endpoints, or key-management screens. This installation holds one person's data. Do not add `user_id`, `owner_id`, or `tenant_id` columns or arguments for future expansion.

Do not build file uploads or object storage. Do not add external data adapters, barcode lookup, a food database, reusable food definitions, recipes, meal-planning entities, or persisted meal-estimate previews.

Do not store goals, targets, target proposals, calorie budgets, recommendations, coaching plans, conversation history, or future planned workouts/meals. Notes must explain an actual recorded observation or event, not serve as a general-purpose memory database.

Do not build automatic device synchronization or third-party integrations in this version. Supplied provenance is record metadata, not proof of a verified integration.

Do not add queues, workers, schedulers, reminders, vector search, Redis, microservices, a rules engine, clinical alerting, or emergency monitoring. Compute small read summaries from stored data on demand. Database backups and operator maintenance are infrastructure, not product features.

## 3. Static API-key authentication

### Required backend authentication

Configure one operator-supplied secret through an environment variable:

```dotenv
AUTH_KEY=<operator-provided-high-entropy-secret>
DATABASE_URL=<postgresql-connection-string>
DEFAULT_TIMEZONE=Asia/Kolkata
PORT=3000
NODE_ENV=production
```

The operator creates the secret outside the application using a cryptographically secure method with at least 32 random bytes of entropy. Do not generate, display, persist, or rotate it through application APIs. Fail startup when the secret is missing, empty, or clearly a placeholder; validate a documented minimum encoded length, without pretending length proves randomness.

Authenticate REST and MCP using:

```http
Authorization: Bearer <AUTH_KEY>
```

This is an opaque static secret carried in an HTTP Bearer header, not an OAuth token or JWT. Do not implement JWT decoding, OAuth discovery, registration, token exchange, login sessions, refresh tokens, or grants.

Require the key on every MCP transport request, including initialization, tool discovery, calls, and session operations when supported by the transport. Require it on all `/v1/*` routes and `/openapi.json`. A minimal `/healthz` may be unauthenticated; `/readyz` should be internal-only or authenticated and must not reveal connection details.

Use a timing-safe comparison of fixed-length digests, strict header parsing, TLS at the service or trusted ingress, bounded requests, timeouts, and rate limiting. Do not log credentials, health request/response bodies, database parameters, or tool argument payloads. Protect reverse-proxy and tracing logs too. Health responses should use `Cache-Control: no-store`.

Never accept the key in query parameters, URL paths, tool arguments, request JSON, or cookies. Clients supply it only through their private HTTP authorization-header configuration. An MCP session identifier is not authentication. A malformed or missing key returns 401 before any health data or tool metadata is returned. Keep the SDK's origin/host protections enabled and explicitly configure trusted proxy behavior; CORS and network allowlists are not substitutes for the API key.

Rotate the secret by changing deployment configuration and restarting/redeploying, then updating the trusted client's secret configuration. The application supports one active key, not a key-management system. Document that anyone holding that key has access to the entire single-user datastore; this scheme cannot identify distinct callers.

### Transport requirements

Both REST clients and MCP harnesses authenticate through the same `Authorization: Bearer <AUTH_KEY>` header. Do not introduce vendor-specific authentication paths, an authentication proxy, separate client accounts, or an unauthenticated fallback.

Test authenticated initialization, tool discovery, tool calls, REST reads/writes, and session operations where supported. Test that missing or invalid authorization fails before protected metadata or records are returned.

## 4. Shared record model

Keep the storage compact. A suitable design is three primary tables:

```text
health_records
  id, record_type, schema_version, version
  occurred_on, occurred_at, ended_at, timezone, time_precision, date_basis
  recorded_at, updated_at, status, validity
  provenance JSONB, payload JSONB

record_revisions
  record_id, version, snapshot JSONB, changed_at, reason

idempotency_requests
  operation, idempotency_key, request_hash, result_metadata, committed_at
```

JSONB is acceptable here because this is a small single-user service, but every payload must pass a strict, versioned, discriminated schema. Do not expose arbitrary database JSON writes. Keep frequently filtered fields outside JSONB and add appropriate indexes. Never use string-built SQL from client values.

Allowed record types:

```text
measurement
nutrition
hydration
activity
sleep
checkin
intake
lab_result
```

`health_log_measurements` and `health_log_lab_results` create bounded atomic batches of these individual records; each laboratory analyte is separately correctable. Other logging tools create one record per call. A batch returns all created IDs/versions and creates no rows when any member fails validation.

Common server-controlled properties include UUID `id`, initial `version=1`, creation/update timestamps, and revision metadata. Mutations cannot choose server IDs, modify record types, rewrite prior revisions, or claim an authenticated clinician/user identity.

### Dates

Require an explicit calendar date for measurements, nutrition, hydration, workouts, sleep, check-ins, and intake. REST/MCP arguments use ISO calendar dates, not relative-date strings. Return the effective date and timezone. Use `DEFAULT_TIMEZONE` only when no timezone is supplied.

When only a date is known, persist a date without inventing midnight or a precise measurement time. When an exact timestamp is known, persist its UTC instant and retain the supplied timezone/offset. Never substitute a record's creation time for its measurement or specimen-collection time.

For ordinary events, derive the local date from a known timestamp and reject conflicting date/timestamp input. Sleep is assigned to its local wake date instead; explicitly supplied duration-only sleep uses the reported wake date. Daily-total records use a local calendar date and have no invented event instant.

Lab results use specimen-collection time/date when supplied; otherwise report date with `date_basis=report_date`. Undated labs may have `occurred_on=null`, `date_basis=unknown`, and their original textual date notes; exclude them from chronological trends and disclose them as undated. Date-based searches must offer `include_undated` rather than assigning them an invented date.

For studies and timed collections, additionally preserve `effective_period`, duration and coverage. This can remain a strictly validated payload object with indexed dates as needed; it does not require another storage service. Do not force multi-day data into a single-day sum. Reject future completed events, allowing only a small documented clock-skew tolerance for precise timestamps. Historical records must not move to another day when the deployment's default timezone changes.

### Provenance and uncertainty

Persist bounded structured provenance such as:

```text
source_type:
  manual | device | laboratory | calculated | other

value_kind:
  measured | reported | estimated | calculated

source_description: optional short source label
source_locator: optional short source reference
assumptions: optional short strings
field_overrides: optional bounded map for known payload fields
```

Source and value kind are distinct. A device-sourced value may be measured or estimated; a manually supplied value may be reported or calculated. Preserve these attributes independently. Source metadata is supplied by the caller and does not imply clinical verification or a verified integration.

Record validity is `valid | suspect | invalid`; status is `active | voided`. Here `valid` means eligible for ordinary use under the supplied provenance, not clinically verified. Support field-level validity and provenance overrides so a workout can be valid while its heart-rate field is invalid. The catalog must specify addressable field paths; reject overrides for nonexistent fields.

An estimated calorie value remains an estimate after storage or correction unless the replacement explicitly supplies different provenance. Confidence labels/ranges are optional; do not invent numerical confidence or claim statistical calibration. Preserve unresolved values as unknown with optional original value text and an uncertainty note.

Provenance consists of bounded structured metadata only. It must not contain credentials or arbitrary embedded payloads. A source reference does not imply that the service can retrieve an external source.

### Numbers and units

Unknown is null/absent, not zero. Real zeros remain valid. Reject NaN/infinity, incompatible units, structurally impossible values, and malformed quantities. Flag unusual but possible readings rather than silently normalizing them to a plausible value.

Use the central code-maintained schema/catalog registry defined in Section 6.1 and exact decimal storage/arithmetic for summation where needed. Normalize only supported, tested conversions and preserve original values/units. Do not round intermediate sums repeatedly. Do not infer nutrient-specific IU conversions or substitute compound weight for elemental nutrient content.

Schemas must distinguish consumed-entry totals from per-100-g or per-serving composition. This service accepts already-supplied amounts for the consumed intake or reported day, not a scaling/serving API. Preserve per-field qualifiers, component definitions and measurement basis as described in Section 5.2.

## 5. Expanded supported records and fields

### 5.0 Coverage and implementation principle

This revision expands data coverage, not product architecture. Keep the same eight record types and sixteen MCP tools. All listed keys are required registry coverage for this implementation; most individual values remain optional. A person is never expected to supply every field or undertake the tests listed here. Clinical panels are discoverability groups, not suggested investigations.

The embedded field inventory in Appendix A enumerates application identifiers and group memberships. It is a build-time inventory, **not** a deployed capability response, a complete runtime schema, or a verified clinical-code crosswalk. Implement the strict definitions and tests before advertising a field as supported. The standalone requirements below remain authoritative for semantics.

Broader coverage is not a claim to include every possible medical test or food compound. Use versioned code-maintained definitions and the existing typed custom-laboratory-result variant for uncommon analytes. Do not add a runtime schema editor, an arbitrary JSON extension bag, or a new service.

Public report examples and laboratory catalogs were used to identify representative field families, while FHIR/LOINC/UCUM informed the structural distinctions. The design does not implement a FHIR server or require an external terminology service. Original report-specific values, units, methods and reference information always outrank a guessed standardized interpretation. [S09–S16]

#### Shared result and context primitives

Use a small set of strict reusable primitives rather than a different ad-hoc value format for every test. The following are application contracts; their exact wire names must appear in the generated schemas and catalog.

| Primitive | Contract |
|---|---|
| `Quantity` | Decimal value, machine-readable unit when recognized, original printed unit/value, optional comparator, and optional reported precision. Preserve decimal text where needed for round-tripping. No implicit significant-figure increase. |
| `ResultValue` | Closed union of `quantity`, `interval`, `coded`, `ordinal`, `ratio`, `titer`, `text`, `absent`, and the explicitly specialized microbiology structures below. Each branch has a discriminator and bounded fields. |
| `quantity` | `value`, optional `unit`, `comparator` in `eq/lt/le/gt/ge`; default equality only when no inequality is supplied. A quantity at a detection boundary is not an exact observation at that boundary. |
| `interval` | `lower`, `upper`, their inclusivity, one common unit when applicable, and original wording. Validate ordering, not a universal clinical range. |
| `coded` / `ordinal` | Preserve supplied display text and optional verified code. Ordinal scale is named/versioned with an explicit order if known; `trace`, `1+`, and `2+` are not invented concentrations. |
| `ratio` | Numerator, denominator, optional component units and original ratio text. Preserve the reported basis rather than dropping the denominator. A denominator cannot be zero. |
| `titer` | Preserve dilution text, numerator/denominator when actually known, comparator and assay context. `1:160` is a dilution result, not a scalar concentration of 160. |
| `text` | Bounded result text attached to the specific observation, such as morphology or a stated pattern; not a full report, diagnosis ledger, instruction, or arbitrary document blob. No numeric trend. |
| `absent` | Explicit `reason`: `unknown`, `not_measured`, `not_performed`, `pending`, `insufficient_specimen`, `specimen_rejected`, `below_detection_unquantified`, `unreadable`, `not_applicable`, `withheld`, or `other` with explanation. No numeric result. |
| `ReferenceRange[]` | Supplied lower/upper limits, inclusivity, text, units, applicable age band/sex-related reference context when explicitly present, specimen, method, fasting state, pregnancy/gestational context and source version if supplied. Multiple ranges can coexist; do not select one using inferred personal attributes. |
| `EffectivePeriod` | Known `start`/`end` dates or instants, time precision and original timezone; distinguish the period covered from when its summary was produced. Store known duration even when exact endpoints are unknown. |
| `Coverage` | Expected/observed sample counts, covered duration or percentage and gaps **only when supplied or directly counted from available records**; never assume complete device coverage. |
| `MethodContext` | Supplied method name, assay/version, instrument/model, firmware/software version, equation and calibration/reference basis. These are inert supplied labels, not verified device identities. |
| `ReportedScore` | Supplied score, scale/instrument name and version, possible bounds and component context when supplied. No proprietary score calculation, questionnaire copying, inferred diagnosis or generated risk classification. |

The result shape separates an observed zero, negative qualitative result, result not performed, and value below detection. Each remains distinct on storage, corrections, reads, exports and summaries. FHIR's observation structure is a reference for these distinctions; the exact contracts above are application design choices. [S13]

`source_status` (`preliminary`, `final`, `amended`, `corrected`, `cancelled`, `unknown`) is separate from datastore `status=active|voided`, data validity and record revision. Normal reads retain the status. Default numeric summaries exclude preliminary/cancelled/absent/unresolved results and disclose exclusion counts; an explicit read option may include preliminary values without claiming they are final. `unknown` status is not silently promoted to `final` and does not alone discard an otherwise usable supplied result.

Never use a laboratory's normal interval as a hard validation range. Signed quantities such as z-scores, electrical axes, base excess, device temperature deviations and source-reported assay values may legitimately be negative. Validate the declared quantity, unit and structural constraints for each field; do not put `minimum: 0` on all health numbers.

#### Relationships, dates and non-duplication

Support bounded `related_record_ids` with an allowlisted relationship (`same_event`, `component_of`, `derived_from`, `alternative_representation`, `reported_with`). Enforce referential integrity and prevent self-links/cycles where the relationship requires a hierarchy. Relationships do not authorize implicit modification of linked records.

A study summary may contain typed registered components in one measurement record. Do not also create independent scalar records for its components automatically. Trend reads may project components using a stable component path and source ID. A caller separately submitting a scalar representation must explicitly link it as an alternative; summaries either select a declared representation or flag unresolved duplication rather than guess from similar values.

Effective periods apply to CGM, ambulatory BP, timed specimen collections, study summaries and actual administration intervals. An interval's report date must not become a fabricated single-day measurement. Daily reads return an interval summary as a labelled overlapping study, not as a day's total. Unresolved start/end precision never becomes assumed midnight.

### 5.1 Measurements, vitals and supplied study results

Use `measurement.kind=scalar|blood_pressure|study_summary`. Scalar and component results use the shared primitives permitted by their definitions. The named `blood_pressure` branch keeps systolic and diastolic values paired. A study summary uses a code-defined `study_type` and bounded, allowlisted components, never arbitrary user-defined schema.

Canonical measurement and study keys:

| Group | Canonical keys |
|---|---|
| `anthropometry_body_composition` | `weight`, `height`, `waist_circumference`, `hip_circumference`, `chest_circumference`, `neck_circumference`, `upper_arm_circumference`, `thigh_circumference`, `calf_circumference`, `body_fat_percent`, `fat_mass`, `lean_mass`, `fat_free_mass`, `skeletal_muscle_mass`, `appendicular_lean_mass`, `body_water_percent`, `total_body_water`, `intracellular_water`, `extracellular_water`, `extracellular_total_water_ratio`, `visceral_fat_area`, `visceral_fat_level`, `segmental_fat_mass`, `segmental_lean_mass`, `segmental_body_fat_percent`, `phase_angle`, `skinfold_thickness`, `bmi`, `waist_hip_ratio`, `waist_height_ratio`, `fat_mass_index`, `fat_free_mass_index`, `appendicular_lean_mass_index`, `body_surface_area` |
| `cardiovascular` | `blood_pressure`, `heart_rate`, `heart_rate_recovery`, `hrv_sdnn`, `hrv_rmssd`, `hrv_pnn50`, `pulse_pressure`, `mean_arterial_pressure`, `pulse_wave_velocity`, `ankle_brachial_index`, `pr_interval`, `qrs_duration`, `qt_interval`, `qtc_interval`, `p_axis`, `qrs_axis`, `t_axis`, `atrial_fibrillation_burden`, `premature_ventricular_contraction_count`, `left_ventricular_ejection_fraction`, `global_longitudinal_strain` |
| `respiratory_temperature` | `oxygen_saturation`, `respiratory_rate`, `body_temperature`, `skin_temperature`, `skin_temperature_deviation`, `peripheral_perfusion_index`, `peak_expiratory_flow`, `fev1`, `fvc`, `fev1_fvc_ratio`, `fev1_vc_ratio`, `fef25_75`, `slow_vital_capacity`, `total_lung_capacity`, `residual_volume`, `functional_residual_capacity`, `diffusing_capacity_co`, `carbon_monoxide_transfer_coefficient`, `fractional_exhaled_nitric_oxide` |
| `glucose_ketones` | `blood_glucose`, `interstitial_glucose`, `blood_beta_hydroxybutyrate`, `blood_ketones`, `breath_acetone` |
| `fitness_function` | `vo2_max_absolute`, `vo2_max_relative`, `ventilatory_threshold_oxygen_uptake`, `ventilatory_threshold_heart_rate`, `ventilatory_threshold_power`, `grip_strength`, `gait_speed`, `six_minute_walk_distance`, `timed_up_and_go_duration`, `sit_to_stand_repetitions`, `sit_to_stand_duration`, `single_leg_stance_duration` |
| `bone` | `bone_mineral_density_areal`, `bone_mineral_content`, `bone_density_t_score`, `bone_density_z_score` |
| `vision_hearing` | `visual_acuity_snellen`, `visual_acuity_logmar`, `intraocular_pressure`, `spherical_refraction`, `cylindrical_refraction`, `refraction_axis`, `hearing_threshold` |
| `study_summaries` | `cgm_summary`, `ambulatory_bp_summary`, `spirometry_summary`, `body_composition_summary`, `dxa_summary`, `ecg_summary`, `echocardiography_summary`, `functional_test_summary` |

For scalar keys the catalog must specify the exact unit and context policy. Recommended bases include mass in kg, circumference/height in cm, water volumes in L, BMD in g/cm2, ECG intervals in ms, angles in degrees, lung volume in L, gas flow in L/s or L/min as defined, and counts/rates with named denominators. Preserve original units; do not infer a conversion for an unfamiliar device scale. Some values have typed non-numeric forms, for example Snellen visual acuity.

#### Measurement-specific metadata

| Family | Required supported fields and distinctions |
|---|---|
| Body composition | `body_region`, `laterality`, `method` (reported BIA/DXA/caliper/other/unknown), hydration/fasting/exercise context when supplied, device model; segmental lean/fat values use region/side qualifiers. ICW/ECW/TBW are quantities with units; ECW/TBW is a ratio. Phase angle requires measurement frequency and site when supplied. A vendor's visceral-fat **level** is not visceral-fat area or mass. Preserve unknown distinctions rather than infer them. |
| Circumference and skinfolds | Anatomical site, side, relaxed/flexed context, landmark description, caliper/method and repeated-reading designation. Do not merge calf and thigh or arbitrary waist sites as perfectly comparable series. |
| BP/pulse | Systolic/diastolic pair, optional pulse, arm/site, posture, cuff size, rest duration, measurement sequence, exercise/medication timing when supplied, device/method. Do not compute a new BP diagnosis or treat a single pulse as resting by default. |
| HRV and recovery | SDNN, RMSSD and pNN50 have different keys; retain observation-window length, units and signal method. Recovery pulse/drop must distinguish actual HR from drop-from-peak, elapsed recovery interval and active/passive recovery. |
| ECG / echo | Observed intervals/axes, lead/context if supplied, QT-correction formula and beat/rhythm context; LVEF/strain method, view/chamber and strain convention. No waveform upload, automated rhythm interpretation, or inferred cardiac diagnosis. |
| Oxygen and temperature | Measurement site, room air versus oxygen support if reported, flow and FiO2 with explicit unit, pulse-ox versus other method, temperature site/method and absolute versus baseline-deviation quantity. |
| Spirometry and lung function | Observed value, reported predicted value, percent predicted, lower limit of normal, z-score and reference equation/version; pre/post-bronchodilator state, agent/dose/elapsed time if reported, test acceptability/quality grade and repeatability information. DLCO corrections and inspired-volume context are explicit when supplied. |
| Glucose/ketones | Blood versus interstitial specimen/system; fasting/random/pre-/post-meal context, elapsed minutes and challenge metadata when known. Blood beta-hydroxybutyrate, unspecified blood ketones, breath acetone and urine ketones are not interchangeable. |
| Physical function | Side, device/protocol, test duration, assistance, walking aid and repeated attempt number. A six-minute-walk distance, free-living distance and treadmill workout distance are separate observations. VO2 absolute and relative values have distinct identities. |
| DXA/bone | Scan site and side, vertebral levels included/excluded when supplied, device/method, areal BMD versus BMC, T-score versus Z-score, reference database and reported comparison/precision information. No generated fracture-risk score. |
| Vision/hearing | Eye/ear side, corrected versus uncorrected vision, Snellen numerator/denominator and distance/unit versus logMAR; tonometry method; hearing frequency in Hz, dB HL versus dB SPL, air/bone conduction and masking when supplied. No conversion by name similarity. |

Body-composition, spirometry and DXA sources demonstrate why method/site/reference context belongs beside the value; the registry above is an application inventory rather than a vendor-report clone. [S19, S27, S28]

#### Structured study summaries

**CGM (`cgm_summary`):** observed period, days covered, active-data percentage, sample/coverage metadata, mean/median glucose, SD, coefficient of variation, reported GMI, glucose unit, and bounded `bands[]`. Each band has supplied lower/upper thresholds with units/inclusivity, label, duration/percentage and denominator. Optional supplied hypoglycemic/hyperglycemic event counts retain event-definition metadata. These thresholds define how the observed summary was measured; they are **not stored personal targets**. Do not invent default bands, calculate missing GMI, substitute GMI for laboratory HbA1c, or add overlapping-period percentages. [S17]

**Ambulatory BP (`ambulatory_bp_summary`):** recording period, attempted/valid readings, daytime/night-time definitions, supplied overall/day/night systolic and diastolic means, pulse means, and reported dipping percentage with its calculation basis. Unknown sleep/wake boundaries stay unknown. No diagnosis or new threshold generation.

**Spirometry, body-composition, DXA, ECG, echo and functional summaries:** retain their typed component results and family-specific context above. Scalar component keys refer to the same code definitions used by standalone measurements. At most one authoritative representation of the same supplied observation contributes to a particular aggregate.

No raw signal streams, continuous waveform database, imaging archive, map/GPS trace, or full diagnostic-report narrative is required.

### 5.2 Daily nutrition and food-component amounts

A nutrition record remains a small **consumed-intake or explicitly supplied daily-total** entry, not a food catalog, recipe or estimation object. It contains `entry_kind=intake|daily_total`, date/optional intake time, optional label, sparse `nutrients`, optional `nutrient_qualifiers`, bounded `component_details`, and provenance.

All keys below represent supplied amounts for that intake/day; units are encoded in their suffixes. `g`, `mg`, `ug`, `kcal` and `kJ` are the declared machine units (the `energy_kj` key binds to `kJ`, not lowercase `kj`); `ug` is the ASCII microgram spelling. Null/absent means unknown, never zero. The catalog labels nonessential/bioactive food components as such; inclusion does not imply an established requirement, benefit, safe dose or need to track them.

| Group | Canonical keys |
|---|---|
| `energy_proximates` | `energy_kcal`, `energy_kj`, `protein_g`, `fat_g`, `carbohydrate_g`, `water_g`, `ash_g`, `nitrogen_g`, `alcohol_g` |
| `carbohydrates_fiber_sugars` | `available_carbohydrate_g`, `carbohydrate_by_difference_g`, `starch_g`, `resistant_starch_g`, `fiber_g`, `soluble_fiber_g`, `insoluble_fiber_g`, `beta_glucan_g`, `inulin_g`, `fructooligosaccharides_g`, `galactooligosaccharides_g`, `total_sugars_g`, `added_sugars_g`, `free_sugars_g`, `glucose_g`, `fructose_g`, `galactose_g`, `sucrose_g`, `lactose_g`, `maltose_g`, `trehalose_g`, `allulose_g`, `total_sugar_alcohols_g`, `erythritol_g`, `sorbitol_g`, `mannitol_g`, `xylitol_g`, `maltitol_g`, `lactitol_g`, `isomalt_g` |
| `fat_classes` | `saturated_fat_g`, `trans_fat_g`, `monounsaturated_fat_g`, `polyunsaturated_fat_g`, `omega_3_g`, `omega_6_g`, `omega_9_g`, `epa_dha_g`, `cholesterol_mg` |
| `fatty_acids` | `butyric_acid_g`, `caproic_acid_g`, `caprylic_acid_g`, `capric_acid_g`, `lauric_acid_g`, `myristic_acid_g`, `palmitic_acid_g`, `stearic_acid_g`, `arachidic_acid_g`, `behenic_acid_g`, `lignoceric_acid_g`, `palmitoleic_acid_g`, `oleic_acid_g`, `eicosenoic_acid_g`, `erucic_acid_g`, `nervonic_acid_g`, `linoleic_acid_g`, `ala_g`, `gamma_linolenic_acid_g`, `arachidonic_acid_g`, `epa_g`, `dpa_n3_g`, `dha_g`, `cla_g`, `fatty_acid_16_1_undifferentiated_g`, `fatty_acid_18_1_undifferentiated_g`, `fatty_acid_18_2_undifferentiated_g`, `fatty_acid_18_3_undifferentiated_g` |
| `amino_acids` | `bcaa_g`, `alanine_g`, `arginine_g`, `aspartic_acid_g`, `asparagine_g`, `cysteine_g`, `cystine_g`, `glutamic_acid_g`, `glutamine_g`, `glycine_g`, `histidine_g`, `isoleucine_g`, `leucine_g`, `lysine_g`, `methionine_g`, `phenylalanine_g`, `proline_g`, `serine_g`, `threonine_g`, `tryptophan_g`, `tyrosine_g`, `valine_g`, `hydroxyproline_g`, `taurine_g` |
| `minerals_trace_elements` | `sodium_mg`, `potassium_mg`, `calcium_mg`, `magnesium_mg`, `phosphorus_mg`, `iron_mg`, `zinc_mg`, `copper_mg`, `manganese_mg`, `selenium_ug`, `iodine_ug`, `chloride_mg`, `salt_g`, `salt_equivalent_g`, `chromium_ug`, `molybdenum_ug`, `fluoride_mg`, `boron_mg`, `cobalt_ug`, `nickel_ug`, `sulfur_mg` |
| `vitamin_a_carotenoids` | `vitamin_a_rae_ug`, `retinol_ug`, `alpha_carotene_ug`, `beta_carotene_ug`, `beta_cryptoxanthin_ug`, `lycopene_ug`, `lutein_ug`, `zeaxanthin_ug`, `lutein_zeaxanthin_ug` |
| `vitamin_d_e_k_forms` | `vitamin_d_ug`, `vitamin_d2_ug`, `vitamin_d3_ug`, `vitamin_d_25_oh_d3_ug`, `vitamin_e_alpha_tocopherol_mg`, `beta_tocopherol_mg`, `gamma_tocopherol_mg`, `delta_tocopherol_mg`, `alpha_tocotrienol_mg`, `beta_tocotrienol_mg`, `gamma_tocotrienol_mg`, `delta_tocotrienol_mg`, `vitamin_k_ug`, `vitamin_k1_ug`, `dihydrophylloquinone_ug`, `vitamin_k2_mk4_ug`, `vitamin_k2_mk7_ug` |
| `water_soluble_vitamins` | `vitamin_c_mg`, `thiamin_b1_mg`, `riboflavin_b2_mg`, `niacin_b3_mg`, `niacin_equivalents_mg`, `pantothenic_acid_b5_mg`, `vitamin_b6_mg`, `biotin_b7_ug`, `folate_ug`, `folate_dfe_ug`, `food_folate_ug`, `folic_acid_ug`, `five_mthf_ug`, `vitamin_b12_ug` |
| `choline_related` | `choline_mg`, `choline_free_mg`, `choline_from_glycerophosphocholine_mg`, `choline_from_phosphocholine_mg`, `choline_from_phosphatidylcholine_mg`, `choline_from_sphingomyelin_mg`, `betaine_mg` |
| `other_food_components` | `caffeine_mg`, `theobromine_mg`, `phytosterols_mg`, `beta_sitosterol_mg`, `campesterol_mg`, `stigmasterol_mg`, `total_isoflavones_mg`, `daidzein_mg`, `genistein_mg`, `glycitein_mg`, `total_oxalate_mg`, `soluble_oxalate_mg`, `phytate_mg`, `total_purines_mg` |

The component families draw on USDA composition documentation and nutrient lists, FAO/INFOODS definitions, FDA label fields and NIH nutrient-form references. This service does not copy food values or implement those organizations' nutrition recommendations. [S01–S07, S26]

#### Definitions that must be explicit

- `carbohydrate_g`, `folate_ug`, `vitamin_k_ug` and other existing broadly named keys retain their supplied/unknown basis. Do not silently reinterpret historical records under a newly narrower definition. `component_details` can supply recognized basis/form/method metadata; absent metadata remains unknown.
- `available_carbohydrate_g` and `carbohydrate_by_difference_g` describe different bases. Total carbohydrate, fibre, starch, sugars, polyols and resistant starch are not independent totals to add. Do not manufacture "net carbs" or infer a missing fibre amount from subtraction.
- `free_sugars_g` and `added_sugars_g` are not synonyms. Retain a supplied definition/version. Allulose and sugar-alcohol identity remains explicit; no automatic relabeling or calorie rule.
- `ala_g`, `epa_g`, `dpa_n3_g`, and `dha_g` identify particular fatty acids. Undifferentiated 18:1/18:2/18:3 fields must not be renamed as a specific isomer. `cla_g` is a reported conjugated-isomer total. Components of omega classes/fat are not extra grams of total fat.
- Amino acids are quantities in the consumed amount, **not** grams per 100 g of protein or per gram of nitrogen. Cysteine/cystine and asparagine/aspartic acid remain distinct. Hydrolysis/method context may explain a combined result; do not split it by assumption.
- `vitamin_a_rae_ug`, `retinol_ug` and carotenoid masses are different quantities. Lutein+zeaxanthin combined and separate component values are overlapping representations, not additive independent values. [S06]
- `folate_dfe_ug`, folate mass, food folate, folic acid and 5-MTHF must remain distinct. `five_mthf_ug` is the supplied 5-MTHF-moiety mass, not the mass of a calcium/glucosamine salt. Do not infer an equivalence from an ingredient name. [S05]
- D2, D3 and 25-hydroxy D3 are distinct fields; reported vitamin D total retains its source definition. K1, MK-4, MK-7 and unspecified vitamin K are not interchangeable by default. Alpha-tocopherol activity is not the sum of every tocopherol/tocotrienol mass. [S01, S07]
- `choline_from_*_mg` measures the **choline moiety contributed by a compound**, not the whole compound's mass. Compound mass belongs in ingredient-strength metadata if reported there. Do not add free choline, total choline and its fractions together. Betaine remains separate.
- `water_g` is food/intake water content by mass, not an automatically generated drink-volume record. A whole-day food-water estimate may overlap beverage water; no combined hydration amount without an explicit compatible coverage basis.
- `energy_kj` and `energy_kcal` are alternative representations of energy. A catalog-defined conversion may produce a labelled display value when only one exists; it must not create another intake or rewrite an explicitly supplied value. Inconsistent dual representations produce a warning. Preserve `energy_method` (`reported_unspecified`, `atwater_general`, `atwater_specific`, `label_declared`, `other`) when supplied; do not run an energy estimator.
- Reported salt, salt-equivalent and sodium quantities preserve their supplied basis and are not added to one another. Combined `epa_dha_g` and `bcaa_g` amounts are overlapping totals; do not infer constituent proportions or add them to their own components.
- Trace elements, phytate, oxalate, purines, sterols and isoflavones are optional constituent quantities. No generated deficiency/toxicity score, oxalate advice, purine-risk classification or micronutrient target.

Do not convert a reported percentage Daily Value into an absolute nutrient amount without an explicitly established source basis. The base logging contract accepts amounts, not percentages of a dietary target. Per-100-g and per-serving composition inputs are not accepted as consumed totals; the service does not scale food portions.

#### Qualified/rounded nutrition values

The sparse `nutrients` object remains backward-compatible: finite nonnegative number or null for each recognized key. Add a strict companion `nutrient_qualifiers` map, whose keys must be recognized nutrients present in `nutrients`:

```text
(no qualifier or kind=exact): scalar number is the reported point amount
kind=bound: comparator=lt|le|gt|ge; scalar number is the boundary, not an equality
kind=interval: scalar must be null; lower, upper, inclusivity and the key's unit
kind=unquantified: scalar must be null; reason and optional original_value_text
```

Preserve original rounded wording when supplied. A printed zero remains a reported zero; do not invent a detection limit from assumed labeling rules. An estimate can still be a reported point amount with `value_kind=estimated`; an estimate interval must not be collapsed into an invented midpoint. Reject contradictory scalar/qualifier combinations.

Ordinary numeric sums include usable exact-point entries only; qualified bounds/intervals remain separately reported with their source IDs and exclusion counts. Never present the known exact subtotal as a complete amount when qualified/unknown records are omitted. Do not implement interval arithmetic or substitute bounds as point values in this version.

#### Daily-total rule — avoid double counting

Allow at most one active nutrition `daily_total` per local date. A second independent creation conflicts with the existing ID; updates require a correction.

For each nutrient separately, a usable **explicitly supplied daily total, including a bound or interval, overrides intake entries**. Return the supplied qualified total as the effective result; a non-point daily total gives no exact effective numeric value and must not silently fall back to the intake sum as though it were the whole day. A plain null/unknown daily-total field supplies no override, so return a labelled known intake subtotal. An explicit zero daily total does override.

Return `effective_result`, any exact numeric representation, `basis`, source IDs, component/overlap warnings, qualified/missing/estimated counts, and separately the known intake subtotal. Never add day totals to their component entries. Additional intakes after a day total produce `daily_total_present`; they do not change the reported day total silently.

For known incompatible expression bases on a broadly named legacy nutrient key, keep separate labelled subtotals and return `incompatible_definition` rather than a falsely unified exact total. Unknown-basis entries may form their own clearly labelled reported subtotal; unknown basis is not evidence that it is equivalent to a known one. A supplied daily total retains its own declared basis and coverage.

Energy is a special **alternate-unit representation group**, not two unrelated nutrient totals. A deterministic display/sum view normalizes compatible point amounts to kcal using the verified physical unit conversion, choosing one representation per record (prefer the supplied kcal when both agree). This does not fill or rewrite the stored sparse nutrient object. A daily total in either energy unit overrides the energy concept as a whole; it is never added to component intakes in the other unit. A bound/interval daily-energy total stays qualified after unit conversion. If dual supplied representations disagree beyond documented source precision/rounding tolerance, preserve both, flag `conflicting_representations`, and withhold the exact effective energy for that record or day until corrected; do not silently choose a favorable value or fall back to partial intakes as the whole-day amount. Return the basis and conversion provenance.

Display nutrients individually. A complete diary can have incomplete nutrient coverage. Report coverage per nutrient, not a false all-or-nothing "complete nutritional analysis".

### 5.3 Hydration

Keep intake (`volume_ml`) and whole-day summary (`total_fluids_ml`, `water_ml`) variants. Drink types: `water`, `sparkling_water`, `tea`, `coffee`, `milk`, `plant_milk`, `juice`, `soft_drink`, `sports_drink`, `oral_rehydration_drink`, `soup_broth`, `alcoholic_beverage`, `other`, `unspecified`. Drink category is descriptive, not a recommendation.

Support an optional short description, occurrence time, related nutrition record IDs, and supplied administration route (`oral`, `enteral`, `other`, `unknown`). Default hydration summaries mean oral/enteral intake as explicitly tracked; do not pretend to be a hospital fluid-balance chart or add IV drug volume automatically.

Publish one-active-total-per-day, non-additive precedence and incomplete-coverage semantics. Plain water is included within total fluids, not extra. An explicit whole-day total may have broader coverage than the recorded drinks; do not force equality with a partial drink log. If both whole-day fields are supplied, `water_ml > total_fluids_ml` is an actionable structural conflict, not something to correct silently.

Nutrients/caffeine/alcohol belong in nutrition; volumes belong in hydration. Links must not duplicate a nutrient amount or a drink volume. Do not estimate sweating, hydration status, fluid needs or urine output from intake.

### 5.4 Activity and exercise

Keep `entry_kind=workout|daily_total`; no planned workout records. Canonical activity types include the previous set plus `hiking`, `stair_climbing`, `treadmill_incline_walk`, `stationary_cycling`, `indoor_rowing`, `resistance_training`, `pilates`, `dance`, `team_sport`, `racket_sport`, and `other` with a supplied label. A label must not override the type's declared unit/context semantics.

| Object / fields | Supported contract |
|---|---|
| Time | `start_at`, `end_at`, `elapsed_seconds`, `moving_seconds`, `paused_seconds`; supplied moving time is not automatically elapsed time. Unknown pause time remains unknown. |
| Volume | `distance_m`, `steps`, `elevation_gain_m`, `elevation_loss_m`, `floors_ascended`, `floors_descended`. Device floors have a source definition rather than a guessed metre conversion. |
| Speed/terrain | `average_speed_mps`, `max_speed_mps`, `average_pace_seconds_per_km`, `treadmill_incline_percent`, surface/indoor/outdoor/altitude context when supplied. Incline percent is not degrees and may be negative. |
| Cardiovascular | `average_heart_rate_bpm`, `min_heart_rate_bpm`, `max_heart_rate_bpm`, recovery value/elapsed seconds, explicit measurement context and per-field validity. |
| Energy/power | `energy_kcal` with `active|gross|unknown` basis; `average_power_w`, `max_power_w`, supplied `reported_normalized_power_w`, `mechanical_work_kj`. Mechanical work and metabolic calorie expenditure are not interchangeable. |
| Running/cycling dynamics | `cadence` with explicit `steps_per_minute|strides_per_minute|revolutions_per_minute|strokes_per_minute`, `stride_length_m`, `ground_contact_time_ms`, `vertical_oscillation_cm`, `vertical_ratio_percent`, `ground_contact_balance_percent` with side and reference. No pace/stride inference from a vague cadence label. |
| Exertion | Named scale (`borg_6_20`, `cr10`, `reported_other`), value, bounds/meaning if other. An RPE 7 is not interchangeable between different scales. |
| Zones | Bounded heart-rate/power-zone objects with supplied lower/upper thresholds, units, inclusivity, duration and source definition. They describe the performed session, not stored personal training targets. |
| Segments | Optional bounded lap/interval array with index, type, time or elapsed offset, distance, relevant supplied summary metrics, source precision and overlap/coverage. Do not store unbounded second-by-second samples. |
| Rowing | Supplied stroke count/rate, distance, stroke length when reported, drag factor or resistance level with device-specific definition. Do not compare arbitrary machine levels as physical load. |
| Swimming | Pool length/unit, lap/length count with explicit meaning, stroke type, stroke count/rate, open-water context, supplied SWOLF with interval/pool-length basis. No assumed stroke efficiency. |
| Strength | Exercise name, set index, warmup/working/drop designation when supplied, completed repetitions, load with unit, load interpretation (`total`, `per_hand`, `per_side`, `machine_stack`, `bodyweight`, `assistance`, `unknown`), laterality, duration/rest, tempo as supplied, RPE and repetitions-in-reserve. Bodyweight and machine-stack numbers are not silently converted into comparable external load. |
| Daily totals | Steps, distance, active/resting/total energy, exercise/standing/sedentary time, and supplied moderate/vigorous/light activity durations. Preserve definitions where categories overlap; do not sum standing and exercise as mutually exclusive. |

Running-dynamics fields are grounded in device reporting capabilities, but all entered values remain supplied observations, not data from an authenticated device integration. [S20]

Do not add segment/lap values to their enclosing workout total, or workouts to daily totals that may already include them. Summaries expose separate subtotal/basis/coverage and reject or flag unresolved overlap. Do not compute MET, BMR, TDEE, proprietary training scores or calories from heart rate/power. Existing calorie estimates are stored as supplied estimates. No distance trace or GPS coordinates are needed.

### 5.5 Sleep and sleep-study/session results

Keep one `sleep` record per reported session or study (`entry_kind=session|study_summary`) with main/nap/unknown session type. Assign ordinary sessions to local wake date. Multi-night study summaries retain their effective period and do not become a fabricated single-night total.

| Object / fields | Supported contract |
|---|---|
| Timing/quantity | Start/end, time in bed, time asleep, sleep latency, REM latency, wake after sleep onset (`waso_seconds`), total awake time, awakenings and reported sleep efficiency. All durations use explicit seconds on the wire. |
| Stages | Reported N1/N2/N3/REM/awake/unclassified durations, or device-specific light/deep/core labels with named `stage_system`. Optional bounded stage intervals preserve actual instants. Do not convert a device's "light" stage into a specific N-stage or add overlapping stage systems. |
| Subjective | Quality with named scale, optional source-reported device sleep score with algorithm/version when supplied, reported snoring and breathing interruptions, awakening symptoms, perceived restfulness with scale, and source metadata. Unknown booleans are not false. |
| Study metadata | `study_type` (`psg`, `home_sleep_test`, `device_session`, `reported_other`, `unknown`), effective period, recording/monitoring/estimated-sleep duration, scoring rule/version, usable duration and study context. |
| Respiratory events | Supplied AHI, REI, RDI, obstructive/central/mixed apnea indices, hypopnea index, apnea/hypopnea counts and RERA count/index. Each index retains denominator basis (sleep hours, monitoring hours or unknown). Event counts and indices are different quantities. |
| Position/stage subdivisions | Supplied REM/non-REM, supine/non-supine indices with minutes covered and denominator. Do not treat tiny or unknown subgroup coverage as a precise full-night result. |
| Oxygen | Mean/nadir/max saturation, desaturation index with the supplied desaturation definition, count/duration and bounded time-below-threshold records. Thresholds specify the observed report calculation, not clinical alert rules. |
| Arousals/movement | Supplied arousal index/count, respiratory-related arousal index, periodic limb movement index/count and movement-related arousal index. Record source rules; no inferred diagnosis. |
| Cardiorespiratory summaries | Mean/min/max heart rate and respiratory rate with observed window and source. Do not merge them with resting daytime series by default. |
| Actual PAP-use session | Mode and pressure actually reported during the session, unit, use duration, residual device-reported indices, leak with L/min or source unit plus mean/median/percentile basis, mask-off/large-leak duration if supplied. Settings are observed historical facts only: no prescription, schedule, device-control endpoint or dose/pressure recommendation. |

AHI, REI and related study indices need their source method and denominator; they must not be relabelled as equivalent merely because each is expressed per hour. The sleep-study reporting reference supplies the field-family context, not diagnostic criteria for this service. [S18]

Time in bed and time asleep remain separate. Stages are components, not additional sleep. Overlapping sessions/studies are not blindly added. A multi-night report and its individual nights are alternative/overlapping representations and must be labelled or linked accordingly.

### 5.6 Check-ins, symptoms and functional reports

Use bounded, optional structured sections. These are all supplied dated observations, not diagnoses, profiles, inferred personal attributes or monitoring questionnaires.

| Section | Supported fields |
|---|---|
| Ratings | Energy, fatigue, hunger, satiety, thirst, stress, soreness, pain, sleepiness, concentration, motivation, perceived recovery and optional mood. Each rating includes its scale, bounds and meaning/direction; never average incompatible scales. |
| Symptoms | Name/description, body site, laterality, onset time/date precision, duration, frequency, severity with scale, course (`new`, `improving`, `unchanged`, `worsening`, `resolved`, `unknown`), triggers/relievers, associated symptoms and reported effect on daily function. Absence of a symptom log is not a negative finding. |
| Gastrointestinal | Reported bowel-movement count, stool consistency with Bristol type when explicitly supplied, urgency, constipation/diarrhea/nausea/vomiting/reflux/bloating reports, blood/mucus reports and context. Do not turn qualitative reports into stool-laboratory results. |
| Urinary | Reported void count, nocturia count, urgency, pain/burning, visible blood, supplied actual volume when measured and collection duration. No inferred fluid balance or diagnosis. |
| Reproductive | Optional explicitly reported bleeding/spotting amount with source scale, cycle day, actual period start/end, reported pregnancy-test observation reference or gestational context. Do not infer sex, pregnancy, fertility, ovulation or expected cycles from unrelated data. No future cycle predictions. |
| Completed assessment results | Instrument name/version, supplied total/subscale score, bounds, date and completion status. Optional bounded item identifiers/results only when supplied and permissible to store. No copyrighted questionnaire text bundle, automatic screening, score computation or clinical cutoff classification. |
| Actual fasting interval | Reported start/end/duration and context for a completed interval. No fasting goal, automatic fasting detection or calorie inference. |
| Diary completeness | Per-domain `unknown|partial|complete|not_tracked`, with the time reported. Keep coverage separate from nutrient/field availability. |

For repeated same-day check-ins, return the latest explicit completeness value per domain, not an average. Scores/ratings preserve individual observations; a selected daily representation and its method must be explicit. Do not create intake events or symptoms merely because a diary is incomplete.

### 5.7 Actual supplement and medication intake

Keep historical actual events, not regimens or prescriptions. Preserve existing `status=taken|missed|skipped`; add `partially_taken` only with an explicitly supplied administered amount or explanation. The extended status is a versioned enum addition and must be discoverable.

| Object / fields | Supported contract |
|---|---|
| Product | Supplied product name, `category=supplement|medication|other`, optional `product_type` (`tablet`, `capsule`, `powder`, `liquid`, `injection`, `patch`, `inhaled`, `topical`, `vaccine`, `other`, `unknown`) and dosage-form description. No product database. |
| Administered amount | Quantity/unit actually administered, or explicit missed/skipped status. Do not equate prescribed package strength with quantity taken. |
| Ingredient/strength | Bounded ingredients with compound name, reported active-moiety/elemental amount, chemical/salt form, strength numerator and denominator, unit and basis (`per_tablet`, `per_capsule`, `per_ml`, `per_g`, `per_dose`, `other`, `unknown`). Preserve both compound mass and explicitly stated elemental content without inferring one from the other. |
| Administration | Actual route/site, start/end or duration, actual liquid volume and rate when supplied, with-food state, and relevant source timing. A completed prolonged administration is an interval, not a future dosing schedule. |
| Context | Supplied reason for that actual event, reason missed/skipped, related measurement/symptom/nutrition records, and reported reaction. A reaction is an observation, not an automatically registered allergy or causal conclusion. |
| Nutrient contribution | Same sparse nutrient keys/qualifiers as nutrition, under the supplement section. Quantity is the contribution of the **administered dose**, not per-tablet strength unless the administered amount establishes that equivalence. |

Dose, formulation strength, route, site and duration are distinct fields, consistent with the actual-administration distinction in the FHIR reference. No FHIR integration is required. [S21]

A substance expressed in IU retains the named substance/form and printed units. Only explicitly implemented, form-specific conversions may produce a derived amount. Never apply a generic IU conversion or automatically infer elemental iron from a salt name. Dietary nutrients and supplement contributions remain separate by default; a requested combined total uses only compatible known quantities and discloses coverage.

### 5.8 Laboratory results and panels

`health_log_lab_results` still accepts an atomic array with optional shared metadata and persists **one separately correctable `lab_result` per analyte observation**. A panel's existence does not require all its members to be supplied, and an analyte may belong to multiple discovery groups without creating duplicate observations.

| `panel_key` | Required built-in `analyte_keys` |
|---|---|
| `cbc` | `hemoglobin`, `hematocrit`, `rbc_count`, `wbc_count`, `platelet_count`, `mcv`, `mch`, `mchc`, `rdw_cv`, `rdw_sd`, `neutrophils_percent`, `neutrophils_absolute`, `lymphocytes_percent`, `lymphocytes_absolute`, `monocytes_percent`, `monocytes_absolute`, `eosinophils_percent`, `eosinophils_absolute`, `basophils_percent`, `basophils_absolute`, `immature_granulocytes_percent`, `immature_granulocytes_absolute`, `band_neutrophils_percent`, `band_neutrophils_absolute`, `nucleated_rbc_per_100_wbc`, `nucleated_rbc_absolute`, `mpv`, `pdw`, `plateletcrit`, `platelet_large_cell_ratio`, `rbc_morphology`, `wbc_morphology`, `platelet_morphology`, `peripheral_smear_findings` |
| `reticulocyte_hemoglobinopathy` | `reticulocytes_percent`, `reticulocytes_absolute`, `immature_reticulocyte_fraction`, `reticulocyte_hemoglobin`, `hemoglobin_a_percent`, `hemoglobin_a2_percent`, `hemoglobin_f_percent`, `hemoglobin_s_percent`, `hemoglobin_c_percent`, `hemoglobin_e_percent`, `hemoglobin_variant_identification`, `haptoglobin`, `g6pd_activity`, `direct_antiglobulin_test` |
| `glycemic` | `blood_glucose`, `hba1c`, `estimated_average_glucose`, `insulin`, `c_peptide`, `fructosamine`, `glycated_albumin`, `beta_hydroxybutyrate`, `blood_ketones`, `homa_ir_reported` |
| `lipid` | `total_cholesterol`, `ldl_cholesterol`, `hdl_cholesterol`, `triglycerides`, `non_hdl_cholesterol`, `apolipoprotein_b`, `apolipoprotein_a1`, `lipoprotein_a_mass`, `lipoprotein_a_molar`, `vldl_cholesterol`, `remnant_cholesterol`, `total_cholesterol_hdl_ratio`, `ldl_hdl_ratio`, `triglyceride_hdl_ratio`, `apob_apoa1_ratio`, `ldl_particle_number`, `small_ldl_particle_number`, `ldl_particle_size`, `hdl_particle_number` |
| `renal_electrolytes` | `creatinine`, `egfr`, `urea`, `bun`, `uric_acid`, `sodium`, `potassium`, `chloride`, `bicarbonate`, `carbon_dioxide_total`, `calcium_total`, `calcium_ionized`, `phosphate`, `magnesium`, `urine_albumin_creatinine_ratio`, `cystatin_c`, `egfr_cystatin_c`, `egfr_creatinine_cystatin_c`, `creatinine_clearance`, `bun_creatinine_ratio`, `anion_gap`, `measured_osmolality`, `calculated_osmolality` |
| `urine_quantitative` | `urine_albumin`, `urine_creatinine`, `urine_albumin_creatinine_ratio`, `urine_protein_concentration`, `urine_protein_creatinine_ratio`, `urine_albumin_excretion_rate`, `urine_protein_24h`, `urine_creatinine_24h`, `urine_sodium_concentration`, `urine_sodium_24h`, `urine_potassium_concentration`, `urine_potassium_24h`, `urine_calcium_concentration`, `urine_calcium_24h`, `urine_phosphate_concentration`, `urine_phosphate_24h`, `urine_uric_acid_concentration`, `urine_uric_acid_24h`, `urine_urea_nitrogen_24h`, `urine_cortisol_free_24h`, `urine_osmolality`, `urine_collection_volume`, `urine_collection_duration` |
| `liver_protein` | `alt`, `ast`, `alp`, `ggt`, `bilirubin_total`, `bilirubin_direct`, `bilirubin_indirect`, `albumin`, `globulin`, `total_protein`, `albumin_globulin_ratio`, `ast_alt_ratio`, `ldh`, `ammonia`, `bile_acids_total`, `prealbumin`, `fib4_reported` |
| `thyroid` | `tsh`, `free_t4`, `total_t4`, `free_t3`, `total_t3`, `tpo_antibodies`, `thyroglobulin_antibodies`, `tsh_receptor_antibodies`, `thyroid_stimulating_immunoglobulin`, `thyroglobulin`, `reverse_t3` |
| `iron_studies` | `ferritin`, `iron`, `transferrin`, `tibc`, `uibc`, `transferrin_saturation`, `soluble_transferrin_receptor`, `reticulocyte_hemoglobin` |
| `vitamins_minerals` | `vitamin_d_25_oh_total`, `vitamin_d_25_oh_d2`, `vitamin_d_25_oh_d3`, `vitamin_d_1_25_dihydroxy`, `vitamin_b12`, `active_b12_holotranscobalamin`, `folate_serum`, `folate_rbc`, `methylmalonic_acid`, `homocysteine`, `vitamin_a_retinol`, `beta_carotene`, `vitamin_e_alpha_tocopherol`, `vitamin_e_gamma_tocopherol`, `vitamin_c`, `vitamin_b1_thiamine`, `vitamin_b1_thiamine_diphosphate`, `vitamin_b2_riboflavin`, `vitamin_b6_pyridoxal_phosphate`, `vitamin_k1`, `iron`, `calcium_total`, `calcium_ionized`, `magnesium`, `magnesium_rbc`, `phosphate`, `zinc`, `copper`, `ceruloplasmin`, `selenium`, `iodine`, `chromium`, `molybdenum`, `manganese` |
| `inflammation` | `crp`, `hs_crp`, `esr`, `procalcitonin`, `ferritin` |
| `urinalysis` | `urine_ph`, `urine_specific_gravity`, `urine_protein`, `urine_glucose`, `urine_ketones`, `urine_blood`, `urine_leukocyte_esterase`, `urine_nitrite`, `urine_bilirubin`, `urine_urobilinogen`, `urine_rbc`, `urine_wbc`, `urine_albumin_creatinine_ratio`, `urine_color`, `urine_clarity`, `urine_squamous_epithelial_cells`, `urine_transitional_epithelial_cells`, `urine_renal_epithelial_cells`, `urine_hyaline_casts`, `urine_granular_casts`, `urine_rbc_casts`, `urine_wbc_casts`, `urine_waxy_casts`, `urine_crystals`, `urine_bacteria`, `urine_yeast`, `urine_mucus` |
| `coagulation` | `prothrombin_time`, `inr`, `aptt`, `aptt_ratio`, `thrombin_time`, `fibrinogen_activity`, `fibrinogen_antigen`, `d_dimer_feu`, `d_dimer_ddu`, `fibrin_degradation_products`, `anti_factor_xa`, `antithrombin_activity`, `protein_c_activity`, `protein_s_activity`, `lupus_anticoagulant_screen`, `drvvt_screen_ratio`, `drvvt_confirm_ratio` |
| `cardiac_muscle` | `troponin_i`, `troponin_t`, `hs_troponin_i`, `hs_troponin_t`, `bnp`, `nt_probnp`, `creatine_kinase`, `ck_mb_mass`, `ck_mb_activity`, `myoglobin`, `ldh` |
| `pancreatic_digestive` | `amylase`, `pancreatic_amylase`, `lipase`, `gastrin` |
| `bone_metabolism` | `parathyroid_hormone_intact`, `parathyroid_hormone_whole`, `calcium_total`, `calcium_ionized`, `phosphate`, `magnesium`, `alp`, `bone_specific_alp`, `osteocalcin`, `procollagen_type_1_n_terminal_propeptide`, `beta_ctx`, `vitamin_d_25_oh_total`, `vitamin_d_1_25_dihydroxy` |
| `pituitary_adrenal` | `cortisol`, `acth`, `dheas`, `aldosterone`, `renin_activity`, `renin_concentration`, `aldosterone_renin_ratio`, `growth_hormone`, `igf_1`, `metanephrine_free`, `normetanephrine_free` |
| `reproductive_hormones` | `fsh`, `lh`, `estradiol`, `progesterone`, `testosterone_total`, `testosterone_free`, `testosterone_bioavailable`, `shbg`, `prolactin`, `amh`, `dheas`, `androstenedione`, `seventeen_hydroxyprogesterone`, `hcg_quantitative`, `hcg_qualitative`, `inhibin_b` |
| `reproductive_semen` | `semen_volume`, `semen_ph`, `semen_liquefaction_time`, `semen_viscosity`, `sperm_concentration`, `sperm_total_count`, `sperm_total_motility`, `sperm_progressive_motility`, `sperm_nonprogressive_motility`, `sperm_immotile_percent`, `sperm_vitality`, `sperm_normal_morphology`, `semen_leukocytes`, `sperm_agglutination`, `sperm_dna_fragmentation_index` |
| `immunology_autoimmune` | `ana_screen`, `ana_titer`, `ana_pattern`, `anti_dsdna`, `anti_smith`, `anti_rnp`, `anti_ssa_ro`, `anti_ssb_la`, `anti_scl70`, `anti_centromere`, `anti_jo1`, `rheumatoid_factor`, `anti_ccp`, `c3_complement`, `c4_complement`, `ch50`, `immunoglobulin_g`, `immunoglobulin_a`, `immunoglobulin_m`, `immunoglobulin_e_total`, `immunoglobulin_g1`, `immunoglobulin_g2`, `immunoglobulin_g3`, `immunoglobulin_g4`, `allergen_specific_ige`, `anca_screen`, `anca_pattern`, `anca_titer`, `anti_mpo`, `anti_pr3`, `anti_cardiolipin_igg`, `anti_cardiolipin_igm`, `anti_beta2_glycoprotein_igg`, `anti_beta2_glycoprotein_igm` |
| `celiac` | `tissue_transglutaminase_iga`, `tissue_transglutaminase_igg`, `endomysial_antibody_iga`, `deamidated_gliadin_peptide_iga`, `deamidated_gliadin_peptide_igg`, `immunoglobulin_a` |
| `infectious_serology` | `hepatitis_b_surface_antigen`, `hepatitis_b_surface_antibody`, `hepatitis_b_core_antibody_total`, `hepatitis_b_core_antibody_igm`, `hepatitis_b_e_antigen`, `hepatitis_b_e_antibody`, `hepatitis_c_antibody`, `hepatitis_a_igm`, `hepatitis_a_antibody_total`, `hiv_1_2_antigen_antibody`, `hiv_1_antibody`, `hiv_2_antibody`, `syphilis_treponemal_antibody`, `rpr_qualitative`, `rpr_titer`, `dengue_ns1_antigen`, `dengue_igm`, `dengue_igg` |
| `microbiology_molecular` | `hepatitis_b_dna`, `hepatitis_c_rna`, `hiv_1_rna`, `respiratory_pathogen_pcr`, `gastrointestinal_pathogen_pcr`, `pathogen_nucleic_acid`, `organism_culture_identification`, `antimicrobial_susceptibility`, `malaria_parasite_test` |
| `stool_digestive` | `stool_occult_blood_guaiac`, `stool_hemoglobin_fit`, `fecal_calprotectin`, `fecal_lactoferrin`, `fecal_pancreatic_elastase`, `fecal_fat_qualitative`, `fecal_fat_24h`, `stool_collection_mass`, `stool_collection_duration`, `stool_ph`, `stool_reducing_substances`, `stool_rbc`, `stool_wbc`, `stool_ova_parasites`, `stool_helicobacter_pylori_antigen`, `stool_clostridioides_difficile_toxin` |
| `tumor_markers` | `psa_total`, `psa_free`, `psa_free_total_ratio`, `alpha_fetoprotein`, `cea`, `ca_125`, `ca_19_9`, `ca_15_3`, `calcitonin`, `beta2_microglobulin` |
| `therapeutic_drug_monitoring` | `lithium`, `valproic_acid_total`, `valproic_acid_free`, `phenytoin_total`, `phenytoin_free`, `carbamazepine`, `digoxin`, `tacrolimus`, `cyclosporine`, `sirolimus`, `vancomycin`, `gentamicin` |
| `toxicology_metals` | `lead`, `mercury_total`, `arsenic_total`, `arsenic_inorganic`, `cadmium`, `aluminum`, `carboxyhemoglobin`, `methemoglobin`, `ethanol`, `cotinine` |
| `blood_group_immunohematology` | `blood_group_abo`, `rhd_type`, `red_cell_antibody_screen`, `red_cell_antibody_identification`, `direct_antiglobulin_test` |
| `specimen_quality` | `hemolysis_index`, `lipemia_index`, `icterus_index` |
| `blood_gas` | `blood_gas_ph`, `partial_pressure_oxygen`, `partial_pressure_carbon_dioxide`, `bicarbonate`, `blood_gas_bicarbonate_standard`, `base_excess`, `oxygen_saturation_blood_gas`, `oxygen_content`, `lactate`, `ionized_calcium_blood_gas`, `carboxyhemoglobin`, `methemoglobin` |

These 30 groups and their keys are **application-defined**, not a claim that every laboratory uses these bundles. Routine panels are supported alongside specialized result families so later supplied records need not be forced into vague notes. Their presence is not a recommendation to obtain screening, hormone, genetic, tumor-marker, fertility or therapeutic-drug testing. Specialized formats that exceed these typed contracts use a later reviewed schema extension, not an arbitrary executable payload. [S09–S12, S22–S25, S29, S30]

#### Laboratory result metadata

| Field / object | Contract |
|---|---|
| Identity | `analyte_kind`, stable `analyte_key` for built-ins, original analyte name, original panel label, optional explicit catalog panel keys, optional externally verified code/system/version. Preserve original source labels independently. |
| Reporting group | Optional bounded `report_reference`, `report_revision`, `specimen_reference`, laboratory/site and related result IDs. No file, document blob, source download or separate report-management product. A shared reference does not generate missing results. |
| Dates | Collection instant/period, receipt, analysis, issue/report date with known precision. The date for trending follows the specimen observation period, never automatically the issued timestamp. Missing dates stay absent under the existing undated-result rules. |
| Specimen | Type (`whole_blood`, `serum`, `plasma`, `capillary_blood`, `arterial_blood`, `venous_blood`, `urine`, `stool`, `saliva`, `semen`, `swab`, `csf`, `tissue`, `other`, `unknown`), site, collection method, timed/spot context, container/additive if supplied and specimen-quality/interference flags. Do not assume serum from a familiar test name. |
| Procedure/challenge | Method/instrument/assay/version; fasting duration/status; collection clock time; glucose challenge dose, elapsed time and original challenge label; stimulation/suppression context as supplied. These describe completed testing, not orders for future samples. |
| Medication/sample timing | Supplied last-dose time or elapsed time, dose/route if stated, and `peak|trough|random|unknown` designation. No therapeutic-range recommendation or dose adjustment. |
| Result | Shared typed value, unit/original unit, original text, precision and optional reported detection/quantification limits. An instrument's analytical range differs from a clinical reference interval. |
| Source lifecycle | Per-result `source_status`, lab-reported flags, specimen/result-quality indicators, corrected/amended identifiers and source reference. These do not automatically void other records without an explicit correction. |
| Reference information | `reference_ranges[]` and supplied interpretation/flag text. Preserve the source's age/context/method qualification rather than installing universal reference limits. |

Public sample reports include current/previous results, report-specific flags, methods and revised-report information. The datastore must distinguish those concepts instead of treating all visible numbers as current observations. A historical comparison value is a separate observation only when explicitly submitted with its own date/provenance; it must not be silently cloned. [S09–S12, S14]

#### Assay and quantity distinctions

- Specimen, property (concentration, excretion rate, percentage, activity or count), timing, scale and method may change result identity. These are compatible-series dimensions, not decorative notes. This mirrors the dimensions described in LOINC without requiring any particular code mapping. [S15]
- Preserve percentage and absolute differential counts separately; nucleated RBC per 100 WBC is not an ordinary count-per-volume. Reticulocyte hemoglobin and whole-blood hemoglobin are different observations.
- `carbon_dioxide_total` is not silently rewritten to measured/calculated bicarbonate. Urine concentration, creatinine-normalized ratio and timed excretion have distinct keys or required quantity qualifiers. Collection duration/volume are retained; no assumed 24-hour collection.
- `egfr` retains its source equation, filtration-marker basis and BSA normalization (`indexed_1_73_m2`, `absolute`, `unknown`). Cystatin-C and combined-equation identities are explicit. Do not automatically turn a source eGFR into a new risk stage.
- Source-reported direct versus calculated LDL and the calculation equation remain qualified. HbA1c IFCC and NGSP reporting conventions are not merely interchangeable unit labels. GMI belongs to the CGM study, not HbA1c.
- Lipoprotein(a) mass/molar, D-dimer FEU/DDU, troponin assay generations, antibody assay-specific arbitrary units and drug total/free concentrations are separate identities or incompatible series as appropriate. Do not invent a fixed mass-to-molar Lp(a) factor or infer unknown D-dimer basis.
- PTH intact versus whole, different vitamin D metabolites, serum versus RBC folate/magnesium, free versus total hormones and activity versus antigen measurements remain distinct. Biotin/interference flags are preserved when supplied, not inferred from an intake log.
- Source-reported ratios and composite indices (`homa_ir_reported`, `fib4_reported`, antibody ratios) may be stored with supplied formula/version/input references when available. They are observations of a reported calculation. No new score, derived diagnosis or recommended threshold is generated.
- ABO and RhD are separate coded observations; do not infer either from the other. Specimen hemolysis/lipemia/icterus indices are assay/instrument-qualified quality observations, not general symptoms.
- Known generic names with missing context stay unspecified and are excluded from forced cross-assay aggregation. More specific keys/qualifiers are not retroactively inferred into old records. No irreversible normalization by guessed synonyms.

#### Microbiology, ordinal and rare result formats

Retain the common result union and add only these bounded specialized branches where catalogued:

```text
pathogen_result:
  organism_or_target label, optional verified coding
  assay and specimen context
  result: coded presence/absence, qualified quantity, or absent

culture_result:
  reported growth/no-growth text or code
  bounded isolates[]: caller-supplied isolate label, organism, quantity when supplied
  no automatic organism identification or infection diagnosis

susceptibility_result:
  isolate reference + antimicrobial name
  method; MIC quantity/comparator or disk-zone diameter with unit
  source interpretation (S/I/R or original text)
  breakpoint standard/version when supplied
  no computed susceptibility category or treatment recommendation
```

Known-target results may reuse a generic built-in molecular-test key only when the supplied target identity is a required series qualifier. Different pathogens must not collapse into one numeric series. A `text` observation may preserve a named smear/morphology pattern without pretending it is numeric. No genome/sequence archive, whole pathology narrative, or sensitivity rules engine is required.

#### Discoverable analyte and panel identity

Preserve `analyte_kind=builtin` with a validated known key. Unknown built-in keys fail with a discovery hint; aliases are search aids only. A custom result uses `analyte_kind=custom`, `analyte_key=null`, required original analyte name and the same validated result/date/specimen/unit context. It does not create a new catalog entry or silently join a built-in series.

A stable supplied `custom_identity` label may be used as a record filter for repeated custom observations, but it is inert data, not a new metric/schema or permission to combine different methods/specimens. Without a deliberate declared identity and compatible context, custom records return individual observations, not a merged trend.

Every built-in descriptor lists allowed result shapes, conditional context requirements, unit preservation/normalization policy and series qualifiers. External codes are optional and published only after exact verification. There is no draft/review UI, clinician-verification flag or requirement to obtain medical approval through the API.

## 6. MCP tools and REST mappings

Expose exactly these 16 tools for the initial implementation. All REST paths in the table include `/v1`; `/mcp` is the only MCP transport endpoint.

| MCP tool | REST route | Contract |
|---|---|---|
| `health_get_context` | `GET /v1/context` | Bounded current data snapshot: latest usable measurements with age, recent daily summaries, recent lab results when requested, missingness and data-quality warnings. No persisted coaching context or targets. |
| `health_get_daily_summary` | `GET /v1/days/{date}` | One local day's effective nutrient/fluid totals, workout/daily activity, sleep, check-ins and intake, with provenance and completeness. |
| `health_get_trends` | `GET /v1/trends` | Bounded metric history, documented daily/weekly aggregations, sample counts, missing dates, and optional descriptive changes. No predictions or goal progress. |
| `health_list_records` | `GET /v1/records` | Cursor-paginated history by allowed record types, dates, source, validity, status, and catalogued metric/analyte filters. |
| `health_get_record` | `GET /v1/records/{id}` | Fetch a record and optionally its version history. |
| `health_get_catalog` | `GET /v1/catalog` | Discover supported nutrients, lab panels and their analytes, measurements, record fields, units, constraints, and complete input schemas. Filter and paginate metadata without reading health records. |
| `health_log_measurements` | `POST /v1/measurements` | Create an atomic bounded batch of typed body/vital measurements. |
| `health_log_nutrition` | `POST /v1/nutrition` | Log supplied nutrients for a consumed intake or explicit whole-day total. No food lookup or calorie inference. |
| `health_log_hydration` | `POST /v1/hydration` | Log fluid volume for a drink or an explicit daily total. |
| `health_log_activity` | `POST /v1/activities` | Log a completed workout or supplied daily activity total. |
| `health_log_sleep` | `POST /v1/sleep` | Log an actual sleep session or reported sleep duration. |
| `health_log_checkin` | `POST /v1/checkins` | Log subjective ratings, reported symptoms, and explicit diary completeness. |
| `health_log_intake` | `POST /v1/intakes` | Log an actual taken/missed/skipped supplement or medication event. No regimen planning. |
| `health_log_lab_results` | `POST /v1/lab-results` | Save an atomic batch of supplied structured laboratory results, preserving units, dates, result types, and reference ranges. |
| `health_correct_record` | `POST /v1/records/{id}/corrections` | Correct a record using a complete typed replacement, expected version, and reason; retain the prior revision. |
| `health_void_record` | `POST /v1/records/{id}/voids` | Soft-delete one record from effective summaries using expected version and reason. Retain correction history. |

Additional technical HTTP routes: `/mcp`, `GET /healthz`, protected/internal `GET /readyz`, and authenticated `GET /openapi.json`. Do not expose food, recipe, estimate, goal, target, user, profile, upload, integration, OAuth, or conversation-memory routes.

### Read contracts

`health_get_context`: optional sections and `lookback_days` (default 14, maximum 90). Return server time, default timezone, query window, latest values with observation dates/ages, and bounded recent summaries. Latest measurements may predate the lookback window and must be labelled accordingly. Default to excluding lab details unless `include_labs=true`; disclose omitted/undated result counts. Include source IDs and truncation/cursor pointers rather than unbounded record bodies.

`health_get_daily_summary`: explicit `date`, optional sections. Return nutrition/fluid basis, known sums versus reported whole-day totals, missing/estimated counts, diary completeness, relevant source IDs, and warnings. Return qualified nutrition totals using the Section 5.2 precedence rule. List overlapping interval studies separately from daily event totals, and expose source-status/quality exclusions. No target, remaining allowance, deficit, surplus, or compliance score fields.

`health_get_trends`: metric identifiers from the catalog, explicit start/end dates, allowed context/source filters, optional day/week granularity. Limit to 20 metrics and 366 days per call. Return null for unknown days. For weight, a documented default is the last usable measurement per local day before a seven-calendar-day moving average. Include contributing-day counts; do not treat missing days as zero or weight repeated same-day measurements as extra days. Lab results should normally return irregular individual observations without smoothing. Comparator/qualitative/ordinal/titer/interval/absent results remain annotated and are excluded from ordinary numeric averages. Partition by the declared series dimensions (specimen, assay/method, unit/expression basis, site, context and effective-period type as applicable). Missing identity qualifiers are not evidence of equivalence. Use a bounded `include_preliminary` option to inspect source-preliminary values without changing default summary policy. Multi-day CGM/study summaries return as interval observations; never distribute their average or percentage across individual days.

`health_list_records`: default limit 50, maximum 200, stable `(date, recorded_at, id)` ordering with defined null-date placement, opaque cursor, inclusive local-date filters, optional `include_undated`, and allowlisted filters. Defaults exclude voided records. No SQL, arbitrary expressions, or arbitrary JSON path filters.

`health_get_record`: required ID and optional `include_history`; return current version/status and permitted revision history, bounded/paginated if necessary.

`health_get_catalog`: the discovery contract in Section 6.1 below. This replaces the earlier narrow metric-catalog tool and route; do not expose duplicate aliases. No tool creates arbitrary new runtime metrics, nutrients, panels, or schemas. Adding a built-in definition is a versioned code/schema change.

### 6.1 Machine-readable field and capability discovery

#### Purpose and boundary

Make the service self-describing. A client must be able to discover what it can write, the exact keys to use, the value types and units, and which analytes belong to each supported panel, without relying on prose documentation or inspecting existing health records.

Expose ONE read-only MCP tool, `health_get_catalog`, and ONE equivalent REST route, `GET /v1/catalog`. They use the same registry lookup service and return the same domain response. They replace `health_get_metric_catalog` and `/v1/catalog/metrics`; the MCP surface remains 16 tools. There is no need for separate tools per panel or nutrient, additional application services, a registry-management UI, runtime schema mutation, or database-backed definitions.

Authenticate discovery with the ordinary `Authorization: Bearer <AUTH_KEY>` header. Catalog calls do not require an idempotency key, do not mutate records, and must not expose patient values, observed-result counts, actual report labels, caller metadata, or the deployment secret. The same catalog must be returned when the health database is empty or populated.

#### How clients discover contracts

There are two complementary discovery layers:

1. **Operation schemas:** publish complete MCP `inputSchema` definitions through standard `tools/list`, with `outputSchema` for structured results. Publish equivalent REST request/response contracts through authenticated `/openapi.json`. These describe request shape, fields, enums, required properties, nullability, and structural validation. Follow the chosen tested SDK/protocol's schema requirements; do not implement a custom protocol discovery method. [R1, R2]
2. **Domain catalog:** `health_get_catalog` provides concise, searchable domain definitions, panel membership, field semantics, unit policy, context distinctions, aggregation rules, and optional complete schemas for one record type. It is an ordinary domain tool invoked through `tools/call`, not a replacement for `tools/list`.

A catalog call is useful before unfamiliar logging/filtering operations, but is not a required stateful handshake. A valid write must succeed without a preceding catalog request. Tool descriptions for writes and metric-based reads should point to `health_get_catalog` when keys or units are unknown. Do not depend on any particular harness automatically fetching metadata or reading an external schema URL.

#### Arguments and equivalent REST query parameters

| Parameter | Type and default | Meaning |
|---|---|---|
| `category` | Enum, default `overview` | `overview`, `nutrients`, `lab_panels`, `lab_analytes`, `measurements`, or `record_schemas`. |
| `panel_key` | Optional bounded string | Only for `lab_analytes`; restrict to the built-in members of that known panel. |
| `group_key` | Optional bounded string | Only for `nutrients` or `measurements`; restrict to one known group from Section 5.2 or 5.1. Do not combine with `panel_key`. |
| `field_path` | Optional bounded JSON Pointer | Only for an exact `record_schemas` key and `include_schema=false`; return the complete descriptor/subschema at a known payload path. No arbitrary query or mutation path. |
| `key` | Optional bounded string | Exact canonical key within the selected category. For `record_schemas`, this is one of the eight allowed record types. |
| `query` | Optional string, 1–100 characters | Case-insensitive literal search over code-defined keys, labels, descriptions, and search aliases; not SQL, regex, or a health-record search. |
| `include_schema` | Boolean, default `false` | Only for `record_schemas`, and requires an exact `key`; return the complete schemas for that record type. Other categories already return their ordinary field/result-type definitions. |
| `limit` | Integer, default 50, maximum 100 | Page size for list requests. |
| `cursor` | Optional opaque string | Continue the same category and filters against the same catalog version. |
| `catalog_version` | Optional bounded string | Assert the version the caller expects; fail explicitly if it is not the deployed catalog version. |

An empty argument object / `GET /v1/catalog` returns `overview`. Overview is a small fixed response and accepts only `category` and `catalog_version`; reject other filters there. For non-overview requests, `key` cannot be combined with `query`, `cursor`, or an explicit `limit`. `panel_key` plus `key` is permitted as a scoped analyte lookup. `group_key` plus `key` is similarly permitted for a scoped nutrient/measurement lookup. A key outside the selected group is not a successful match. `field_path` requires a known exact record type and cannot be combined with `include_schema=true` or list/search filters. Reject unsupported filter combinations with useful field errors. `include_schema=true` requires `category=record_schemas` and an exact `key`; `include_schema=false` never removes the type/unit/constraint metadata in ordinary entries.

Parse REST booleans, limits, repeated parameters, and empty strings strictly and document the parsing. Identical logical filters must yield identical REST and MCP domain results. Do not accept arbitrary category names, executable predicates, or property paths.

#### Categories and minimum content

| Category | Required content |
|---|---|
| `overview` | Catalog version, supported categories, allowed record types, built-in entry counts per category, supported panel keys, nutrient/measurement group keys and counts, custom-analyte policy, discovery examples, and pointers to `/openapi.json` and the record-schema category. Counts are definition counts, never counts of a person's records. |
| `nutrients` | Every canonical key listed in Section 5.2, group, exact unit/numeric representation, qualifier support, optional/null semantics, accepted intake/day basis, component/form definitions, compatible supplement binding and non-additive relationships. |
| `lab_panels` | Canonical panel key, label, description, aliases, complete member `analyte_keys`, `analyte_count`, and the arguments needed to fetch those analyte definitions. Panel members are optional observations, not mandatory bundle fields. |
| `lab_analytes` | Built-in analyte key, label and aliases, member panel keys, specimen/assay/quantity distinctions, permitted result variants, recognized units, unit-preservation/normalization policy, required context, and logging/trend identifiers where supported. |
| `measurements` | Every supported body/vital metric, exact logging identifier, scalar or paired shape, quantity/unit policy, context fields/enums, allowed field overrides, and series/aggregation behavior. |
| `record_schemas` | Descriptors for all eight record types: writable field index, nested shapes, discriminator variants, relevant tools/routes, and exact enum choices. Includes hydration, activity, sleep, checkin, and intake fields, not only nutrients/labs/measurements. An exact-key request with `include_schema=true` returns complete executable JSON Schemas. |

Each field descriptor must supply, as applicable:

```text
key, label, description, search_aliases
record_type and field bindings
field_path (JSON Pointer relative to that record's mutable data object)
field_schema (type, enum, minimum/maximum only where actually enforced)
required, nullable, unit or unit_policy
applicable_variants and context requirements
aggregation and overlap/component relationships
trend_supported, trend_key when supported, required trend qualifiers
introduced_in, deprecated, replacement_key when applicable
quantity_kind, component_form, expression_basis, source_definition_refs
result_variants and absence_reason_policy
aggregation_role, alternative_representation_of, component_of
series_identity_dimensions, missing_context_policy, normalization_policy
source_status_policy, qualified_value_summary_policy
```

Use structured conditions for variant-specific required fields; do not mark a field unconditionally optional when it is required for one variant. For arrays, publish item schemas and the path-template convention, and require actual indexed JSON Pointer paths on writes/overrides. Define parent/child namespace relationships so a client can determine exactly where each field belongs.

All nested object members, enums, result branches, contexts and qualifier maps must be indexed, not just numeric leaves. For example a harness must discover sleep `respiratory_events`, strength `load_interpretation`, drug `strength` denominators, lab `reference_ranges` and nutrition `nutrient_qualifiers`. Array entries publish the same path-template convention used for field overrides. Registry quantities do not imply universally safe/normal values.

For nutrients, the key fixes the unit: `protein_g` accepts grams, `sodium_mg` accepts milligrams, and so on. Do not advertise a parallel freely chosen unit or silently accept aliases such as `protein` or `carbs`. `field_schema` for a sparse nullable nutrient may be `{"type":["number","null"],"minimum":0}`; a field being optional does not make the entire log record optional or bypass its other required fields.

For laboratory results, distinguish recognized/normalizable units from units preserved as supplied. Retain an unfamiliar reported unit under the documented result schema with no unsupported normalization and no cross-unit numeric aggregation. Qualitative or unresolved results must not require a meaningless numeric unit. Never present clinical reference intervals as universal schema acceptance ranges, and do not reject an abnormal but structurally valid result merely because it falls outside a laboratory's reported interval.

#### Built-in panel membership

The complete required membership list is the 30-group table in Section 5.8 and the embedded inventory in Appendix A. Implement all 424 unique keys, preserve overlapping membership as shared identity, and return complete member-key arrays with counts. Do not maintain a second handwritten membership table. The same registry powers panels, analytes, validation and schemas.

The nutrient and measurement groups in Sections 5.2 and 5.1 are similarly exhaustive required inventories for this revision. Display groups are not writable record identities and never imply that values exist in the datastore. No clinically meaningful distinction may be discarded to reduce the list.

#### Full schemas and a single source of truth

Use ONE code-maintained registry/schema module as the authoritative definition for supported fields, keys, variants, units, and validation metadata. Generate the catalog, runtime structural validators, MCP schemas, and OpenAPI schemas from it, or compose them from the same definitions with exhaustive parity tests. Do not maintain an unrelated handwritten catalog beside independent validators.

A `record_schemas` response with `key=nutrition&include_schema=true`, for example, returns:

```text
record_type, record_schema_version
writable_data_schema
logging_contracts:
  tool_name, input_schema, output_schema
  rest_method, rest_path, request_schema, response_schema
correction_data_schema
field_index
validation_rules (named deterministic cross-field rules not expressible in JSON Schema)
```

Include shared date/provenance fields in full logging request schemas, not only the domain payload. Show REST `Idempotency-Key` as a header parameter and MCP `idempotency_key` as an argument; they are transport-specific wrappers around the same domain command. Include shared lab-batch metadata and array/result envelopes for lab logging. Never represent an atomic batch as an ordinary single-record request schema.

Use complete self-contained schemas with local definitions/references that resolve within the returned schema document. Do not require the harness to dereference arbitrary URLs, and do not return a truncated schema that looks executable. Nutrient objects must enumerate their supported properties and reject unknown properties. Built-in analyte identities must enumerate or otherwise strictly enforce their allowed keys; the custom-analyte variant must remain a separate closed shape, not `additionalProperties=true`.

Local schemas validate structure and permitted keys, but current database state, idempotency, clock-based checks, and uniqueness/version conflicts still require server-side validation. Document those deterministic rules rather than claiming JSON Schema alone can check them.

For large catalogs, narrow metadata responses through filters and pagination. Keep full schemas opt-in by exact record type; however, do not replace write-tool input schemas with an opaque untyped `data` object just to shorten `tools/list`. Metadata discovery is additive to correctly specified tool contracts. [R1, R2]

#### Response envelope, pagination, and versioning

Every discovery response returns `catalog_version` (use `1.0.0` only for a first-ever deployment; when upgrading a deployed v4 catalog, increment its version appropriately and never reuse it for changed definitions), `category`, and its declared response variant. List/lookup responses return `items`, `returned_count`, `total_count`, `has_more`, and `next_cursor`. An exact successful lookup has one item; an unknown key/panel returns an error, not an empty successful lookup. A text search with no matches returns an empty list.

Use deterministic key ordering, bounded results, and opaque cursors bound to the effective filters, ordering, limit, and catalog version. Enforce a response-byte bound as well as an item limit. Pagination must expose `has_more=true` and a valid continuation cursor whenever data remains. Never silently omit fields or panel members to fit a response. If one complete entry/schema cannot fit, return `LIMIT_EXCEEDED` rather than an apparently complete partial schema.

`catalog_version` is distinct from REST `/v1`, MCP protocol revision, and stored-record `schema_version`. Bump it for any deployed definition/schema change; never reuse a version for different content. A provided version or cursor from a different deployment catalog returns `CATALOG_VERSION_MISMATCH` with the current version and guidance to restart discovery. Supporting historical versions or runtime editing is not required.

Include the current `catalog_version` in successful domain read/write metadata and actionable validation errors. Clients can retain definitions within a workflow keyed by that version and refresh after reconnect/deployment changes or a mismatch; no client identity, discovery state table, or per-session catalog storage is needed. Retaining schema metadata must not cache health-record values or secrets. Separate record schema versions from record revision numbers. Retain readers for previously stored schema versions and test an explicit lossless migration path. New fields/enum members must not cause old snapshots, retries or corrections to be reinterpreted silently. A changed clinical definition needs a new key or explicit migration, not just a changed label.

#### Actionable field-validation errors

An unknown nutrient key must not disappear silently or be silently rewritten. Return a normal `VALIDATION_ERROR` identifying the supplied field path, issue, current catalog version, and narrowly bounded suggested canonical keys where unambiguous. A suggestion is not an automatic correction. Include a machine-readable discovery hint, for example:

```json
{
  "code": "VALIDATION_ERROR",
  "catalog_version": "1.0.0",
  "issues": [
    {
      "path": "/data/nutrients/protein",
      "reason": "unknown_field",
      "suggested_keys": ["protein_g"],
      "discovery": {
        "tool": "health_get_catalog",
        "arguments": {"category": "nutrients", "key": "protein_g"},
        "rest_path": "/v1/catalog?category=nutrients&key=protein_g"
      }
    }
  ]
}
```

Map invalid inputs to the documented REST validation status (422), unknown catalog identities to 404/`NOT_FOUND`, and catalog-version mismatches to 409/`CATALOG_VERSION_MISMATCH`. Return corresponding SDK-compatible MCP error results, with `isError=true` for domain/tool-execution failures. Authentication still fails before metadata disclosure. [R1]

#### Discovery request examples

These examples show domain arguments/query paths, not a hand-written protocol envelope. Supply authorization privately through the header.

```text
MCP:  health_get_catalog({})
REST: GET /v1/catalog

MCP:  health_get_catalog({"category":"nutrients"})
REST: GET /v1/catalog?category=nutrients

MCP:  health_get_catalog({"category":"lab_panels"})
REST: GET /v1/catalog?category=lab_panels

MCP:  health_get_catalog({"category":"lab_analytes","panel_key":"cbc"})
REST: GET /v1/catalog?category=lab_analytes&panel_key=cbc

MCP:  health_get_catalog({"category":"lab_analytes","query":"hemoglobin"})
REST: GET /v1/catalog?category=lab_analytes&query=hemoglobin

MCP:  health_get_catalog({"category":"record_schemas","key":"nutrition","include_schema":true})
REST: GET /v1/catalog?category=record_schemas&key=nutrition&include_schema=true

MCP:  health_get_catalog({"category":"record_schemas","key":"activity","include_schema":true})
REST: GET /v1/catalog?category=record_schemas&key=activity&include_schema=true
```

For an exact nutrient lookup, this illustrates the relevant item properties; the implementation must include the declared response envelope and all registry-required metadata:

```json
{
  "key": "protein_g",
  "label": "Protein",
  "record_type": "nutrition",
  "field_path": "/nutrients/protein_g",
  "field_schema": {"type": ["number", "null"], "minimum": 0},
  "required": false,
  "nullable": true,
  "unit": "g",
  "applicable_variants": ["intake", "daily_total"],
  "quantity_basis": "total_for_logged_intake_or_day",
  "aggregation": "daily_total_precedence_else_known_intake_sum",
  "deprecated": false
}
```

The panel-member list answers which analyte keys are supported; the matching analyte definitions and record schema explain how to submit their results. The field catalog describes capabilities only; actual values remain in the ordinary record-read tools.

### MCP metadata and responses

Use strict input/output schemas, documented optional fields, bounded arrays/text, and concise action-oriented tool descriptions. Say when a tool should be used and what it must not do. Descriptions must make logging consumed/observed events distinct from suggestions.

Use structured tool outputs and SDK-compatible text fallbacks. Read tools use `readOnlyHint=true`. Writes are not read-only. Mark corrections and voids conservatively as potentially destructive; do not relabel them to suppress confirmations. Use `openWorldHint=false` for these bounded local-datastore tools. Claim idempotency only where implemented. Tool annotations are hints, not authentication or validation.

Expose domain-specific tools only. No UI resources, rendering templates, vendor-specific metadata, required custom widgets, or prompts that embed the secret. Do not add duplicate `search`/`fetch` aliases.

Successful single writes return `id`, `record_type`, `version`, effective date, persisted values/provenance, and warnings. Batch writes return that information for every member. Reads include enough identifiers to trace a summary back to its records.

Domain failures return stable codes such as `VALIDATION_ERROR`, `VERSION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `DAILY_TOTAL_EXISTS`, `NOT_FOUND`, `CATALOG_VERSION_MISMATCH`, and `LIMIT_EXCEEDED`, plus useful field paths. Map them to documented HTTP statuses and SDK-compatible MCP error results. Do not return HTTP-success-looking saved records after rollback. Never expose stack traces, secrets, or raw database errors.

## 7. Idempotency, corrections, and data integrity

Require `Idempotency-Key` for every REST mutation and `idempotency_key` in every MCP mutation. Use the same operation identity and canonical domain-payload hash across both transports; a REST retry of an MCP action can reuse its key.

Enforce uniqueness on `(operation, idempotency_key)` with a database constraint. The identical key/payload returns the original committed mutation result; a different payload returns 409/`IDEMPOTENCY_CONFLICT`. Atomically commit records, revision information, and idempotency metadata. Concurrent identical requests create only one event. Check a committed retry before applying version preconditions again.

Keep keys durable across process restarts and deployment-key rotation. Do not expire deduplication silently after a short in-memory cache timeout. Store result IDs/versions and minimal metadata rather than unnecessary duplicate health payloads. A retried mutation may reference its originally committed version even after a later correction; explicitly identify that version, never reapply the old write.

Use `expected_version` for corrections and voiding. A correction supplies a full replacement of mutable record data, validated by the existing record type's schema; it cannot alter server IDs, type, original creation time, or unrelated records. Any changed date or daily-total kind must recheck uniqueness constraints. Null clears an optional value; complete replacement avoids ambiguous partial JSON patch behavior.

Voiding removes a record from effective calculations but is not irreversible erasure. Correcting a voided record does not silently restore it; keep restoration outside the initial MCP surface. Correct individual suspect fields through a new revision rather than overwriting history.

Do not deduplicate independent events merely because their timestamps or values resemble each other. Request idempotency prevents retries, not semantically similar meals. Optional caller event references can identify a known source event; store only references explicitly supplied by the caller.

Compute summaries from current active records, respecting field validity, so corrections and voids affect subsequent reads immediately. Invalid/suspect data is excluded by default and can be inspected explicitly. Completeness, estimation, validity, and source are separate dimensions.

## 8. Example inputs

These are synthetic API examples, not records to seed into the user's database. The implementation must make the examples executable against its final schema and keep the README synchronized.

### Logging an intake with estimated nutrients

`health_log_nutrition`:

```json
{
  "idempotency_key": "example-nutrition-event-001",
  "occurred_on": "2026-10-02",
  "timezone": "Asia/Kolkata",
  "time_precision": "date",
  "date_basis": "reported_date",
  "provenance": {
    "source_type": "manual",
    "value_kind": "estimated",
    "source_description": "Supplied intake estimate",
    "assumptions": ["Portion size was estimated; added cooking oil is uncertain."]
  },
  "data": {
    "entry_kind": "intake",
    "label": "Lunch",
    "nutrients": {
      "energy_kcal": 430,
      "protein_g": 26,
      "carbohydrate_g": 45,
      "fat_g": 16,
      "fiber_g": null
    }
  }
}
```

This creates a nutrition intake record with estimated nutrient values. It does not create a food definition, recipe, target, or separate estimate object.

### Whole-day total precedence

A nutrition `daily_total` record for the same date containing `energy_kcal=1900` and `protein_g=100` makes the day's effective energy/protein totals 1,900/100, not those values plus the lunch entry. Other nutrients without total overrides remain explicitly labelled known intake sums. Updating the whole-day total later requires its ID/version and a correction.

### A problematic treadmill pulse

Create an activity workout with the supplied duration/speed/incline and calorie provenance. Omit the unreliable pulse or retain it with field-level `validity=invalid` and the reason "User was not using the hand sensors." Summaries exclude the pulse but retain the valid workout data.

### Laboratory result batch

Create a separately correctable lab-result record for every analyte in the supplied atomic batch. Preserve collection/report dates, units, comparator signs, original result text, reference ranges, and source references. Unknown values remain unknown. Records must not imply clinician verification or create diagnoses or targets.

## 9. API and MCP contract documentation

Provide client-independent integration documentation and MCP server instructions describing the service's capabilities and record semantics:

- Supported record types, discoverable nutrient keys, panel/analyte membership, complete schemas, units, date precision, provenance, and validity rules.
- Standard MCP `tools/list` and `health_get_catalog` discovery, equivalent `/v1/catalog` queries, versioning, pagination, exact lookups, and error-driven rediscovery.
- The shared `Authorization: Bearer <AUTH_KEY>` header requirement for all protected routes and MCP transport operations. The key is configured privately by the client, never included in tool arguments.
- Equivalent REST and MCP request/response examples, with no dependency on a particular harness.
- Bounded context snapshots, daily summaries, trends, record retrieval, filters, pagination, and truncation indicators.
- Logging contracts for observed events and supplied values, including estimates and unknown fields.
- Non-additive precedence of daily totals, separate dietary/supplemental nutrients, and distinct workout/daily expenditure totals.
- Required idempotency keys, atomic batch behavior, versioned corrections, voiding, stable errors, and retry behavior.

Document that a successful mutation response represents a committed transaction. Returned notes and provenance are inert record data. Do not make guarantees about continuous monitoring, clinical verification, or any external client's behavior.

Start the database empty. Migrations must not seed personal data. Historical records enter through the same explicit logging contracts and retain their dates and provenance.

## 10. Deployment, operator maintenance, and deliverables

Deliver the runnable service, locked dependencies, database migrations, strictly validated schemas, all 16 MCP tools including `health_get_catalog`, REST mappings, an authenticated field catalog, and authenticated OpenAPI JSON. Include the code-maintained registry and generation/parity tests. Use the same domain service functions for both interfaces rather than calling the public REST endpoint from inside each MCP tool.

Include a Dockerfile and minimal service/database local deployment configuration, `.env.example` with placeholders only, startup/readiness checks, safe structured operational logging, documented resource limits, and tests. Do not create a frontend, a key generator, or a database seed with actual personal health data.

Add operator-only commands for a streaming JSON export and intentional permanent erasure, or document equally usable database maintenance procedures. No web UI, stored export object, async export job, arbitrary file path, or bulk-purge MCP tool is required. Do not expose these maintenance privileges as hidden ordinary health tools.

Permanent erasure must cover records, revisions, health-bearing idempotency data, and any accidental sensitive logs/caches; document database backup expiration and restore behavior. Do not describe soft deletion as erasure. Test database backup/restore without requiring an object-storage feature in the application.

Publish an interoperability test report naming the exact tested SDK version, MCP protocol revision, transport, test client or harness, and results. Demonstrate authenticated initialization, tool listing, controlled writes, retrieval from a fresh authorized client session, cross-interface REST/MCP consistency, and rejection of unauthenticated access. Do not claim tests passed without running them. No particular client or harness is a required product dependency.

## 11. Acceptance tests

1. The deployment starts with only the service, PostgreSQL, and configured environment variables. No UI or additional application service is required.
2. Missing/placeholder `AUTH_KEY` prevents startup. Missing, invalid, malformed, or duplicate authorization headers fail closed on all protected REST/MCP routes.
3. The key never appears in schemas, tool outputs, URLs, ordinary logs, errors, or database records. Restarting/rotating it does not reset event deduplication.
4. The schema/routes contain no users, tenants, profiles, goals, targets, food catalog, recipes, file uploads, OAuth, or coaching-memory objects.
5. A date-only weight record retains a date without inventing a timestamp; timestamps crossing a UTC/local-date boundary group correctly in Asia/Kolkata.
6. An atomic measurement/lab batch either saves every valid member or saves none; returned IDs resolve through health_get_record.
7. The same mutation retried or concurrently issued with the same key/payload creates one result across REST and MCP. The same key with a different payload conflicts.
8. A committed write whose response was lost can be retried after restart without duplication. A later correction does not make retrying the original request recreate or revert the record.
9. Wrong expected_version prevents correction/voiding. Valid corrections preserve history and immediately change summary/trend results.
10. Unknown nutrients remain null/absent, genuine zeros remain zero, qualified values retain their form, and calorie-only logs do not acquire made-up micronutrients.
11. Two consumed-intake logs aggregate deterministically. A daily total is never added to those entries. A daily total with only energy/protein overrides only those fields. A qualified daily total overrides its nutrient without being coerced into an exact number.
12. A second active daily-total nutrition/hydration/activity record conflicts; corrections moving a record to another date also enforce uniqueness.
13. New nutrition intake after a daily total generates a warning, retains both underlying records, and does not silently change the effective reported daily total.
14. Logging an estimate preserves the supplied values and estimated provenance in records, reads, corrections, and summaries. No automatic nutrient or expenditure inference occurs.
15. Beverage nutrients and volume are stored in their respective domains without duplication. Water is not added to a total-fluid quantity that already contains it.
16. Workout expenditure and daily expenditure are not double-counted. Unknown/gross energy is not recast as active energy. No calorie budget/deficit is returned.
17. Invalid treadmill pulse is excluded while the rest of the workout remains usable. Field-level uncertainty survives corrections and retrieval.
18. Overnight sleep is assigned to its wake date; stages are not additional sleep; unresolved overlapping sessions produce warnings rather than inflated totals.
19. Missing nutrition/day entries do not mean zero intake, fasting, or a complete diary. No intake record is generated from a supplement schedule or absence of logging.
20. Unknown tablet strength does not produce a nutrient dose; dietary and supplemental nutrient sections remain distinct.
21. Lab comparator, interval, and qualitative values retain their original meaning. Undated/unresolved results remain explicitly undated/suspect, not invented dates/numbers.
22. Incompatible HRV/glucose/lab contexts and units are not merged. Sparse trends show contributing-day counts and null gaps, not filled-in observations.
23. Cursor pagination has stable ordering without omissions/duplicates in a fixed dataset. Read/context size limits and truncation indicators work.
24. Void excludes a record but preserves history; permanent operator erasure removes health-bearing revisions/idempotency material under the documented backup policy.
25. Oversized requests, arbitrary JSON fields, SQL-like filters, embedded executable content, and secret-in-argument attempts are rejected or handled strictly as inert bounded data.
26. MCP tools have correct schemas, structured responses, read/write annotations and no UI resources. Authentication is tested for discovery as well as calls.
27. A fresh authorized client can retrieve previously written records after a service restart. No seed data is inserted automatically.
28. Documentation and tests are client-independent, use `AUTH_KEY` consistently, and demonstrate equivalent authorized REST/MCP behavior without vendor-specific routes or authentication bypasses.

29. With an empty database, `health_get_catalog({})` / `GET /v1/catalog` returns all supported categories, record types, panel keys, definition counts, and the custom-analyte policy without any personal data. Reads do not mutate state and need no idempotency key.
30. Paginated nutrient discovery returns every canonical key in Section 5.2 exactly once, with its precise unit, type, nullability, field binding, and aggregation rule. Each advertised field is accepted in an otherwise-valid write through both interfaces; an unadvertised nutrient key is rejected rather than dropped.
31. Panel discovery returns complete explicit memberships. Analyte discovery filtered by each `panel_key` returns exactly those built-in members; overlapping panels reference the same analyte identity. Partial-panel logging succeeds, and no unreported test result is generated.
32. Exact unknown keys/panels return `NOT_FOUND`, invalid filter combinations return validation errors, and no-match text search returns an empty list. Alias search can find a definition without making aliases writable keys or merging distinct assays.
33. Full `record_schemas` lookups work for all eight record types and include required shared envelopes, nested fields, variants, enums, units, and resolvable local references. Nutrition and activity examples validate without an external schema fetch. Complete lab schemas preserve atomic batch wrappers.
34. The registry, runtime validators, catalog, MCP input/output schemas, and OpenAPI schemas agree on accepted keys/types/units and custom-lab policy. Known-good and known-bad fixtures produce equivalent REST/MCP outcomes, including corrections.
35. Catalog pagination has no omissions/duplicates; response-size limits never produce silent truncation. An old version/cursor returns `CATALOG_VERSION_MISMATCH`; the client can restart discovery using the returned current version. Stored-record schema versions remain distinct.
36. Unknown nutrient/built-in analyte keys produce actionable validation errors with field paths, version, and discovery hints. Explicit custom analytes use the typed fallback without becoming new registry definitions or bypassing result validation.
37. Discovery is protected by `AUTH_KEY` through both transports and contains neither credentials nor health-record values. The limited legacy metric-catalog route/tool is not duplicated. The MCP tool count remains 16.
38. Discovery advertises recognized lab units separately from preserved unconverted units; unknown/unconvertible units remain unnormalized and are not aggregated across incompatible series. Numeric bounds reflect structural rules, not clinical reference intervals; abnormal valid observations are retained.

39. The inventory contains exactly 182 unique nutrient/food-component keys, 424 unique built-in analyte keys in 30 groups, and 110 measurement/study keys for this revision. Generated schema/catalog coverage tests enumerate every key, not a handpicked subset.
40. A source result can independently be preliminary/final/corrected, valid/suspect/invalid and active/voided. Changing a record revision does not falsely claim a final or clinically verified result.
41. A pending test, a cancelled test, a negative qualitative result, an exact zero, an unquantified below-detection result and a quantified upper bound round-trip distinctly.
42. An abnormal but structurally valid result is stored unchanged; negative z-scores/axes/base-excess results pass their appropriate schemas. Clinical reference ranges are not universal validators.
43. Multiple reference ranges preserve their specimen/method/age or explicitly supplied reproductive context. The server does not infer patient attributes to select a range.
44. CBC percentages, absolute counts, NRBC per 100 WBC and reticulocyte hemoglobin remain distinct series; MPV and PDW fields are discoverable and round-trip.
45. A spot urine concentration, albumin-creatinine ratio and timed protein excretion remain separate; collection duration/volume survive export and do not default to 24 hours.
46. Total CO2 is not silently normalized to bicarbonate. Indexed eGFR, absolute clearance and marker/equation-specific eGFR do not collapse into one unqualified trend.
47. Lp(a) mass/molar, D-dimer FEU/DDU, total/free drugs, hormone forms and assay-specific antibody units cannot be combined by generic mass or string conversion.
48. ANA titer and pattern, microscopy ordinals, interval results and organism presence/absence use their typed variants. An incomplete numerator/denominator is not manufactured.
49. Microbiology target/isolate/antibiotic identifiers remain attached to MIC/zone/interpretation observations; no infection or susceptibility classification is inferred.
50. A source report revision and a database correction remain distinct. A report's previous-result column is not automatically submitted as a new current result.
51. A legacy carbohydrate_g, folate_ug or vitamin_k_ug value with unknown definition remains unknown-basis after upgrade; it is not silently renamed or reclassified.
52. Carbohydrate-by-difference and available carbohydrate can coexist without addition; fibre, starch, sugars, polyols and amino acids are not added to their parent macronutrient totals.
53. An energy_kj amount and energy_kcal representation do not create two calories totals. Conflicting source representations warn without overwriting supplied values.
54. A nutrient upper bound such as less than 0.5 g is not stored or summed as exactly 0.5 g. A range has no fabricated midpoint. Reported zero remains zero without an invented labeling limit.
55. A bounded/interval daily nutrient total takes precedence over exact intake sums and produces no falsely exact whole-day value; a plain null daily total does not override, and a real zero does.
56. Choline-moiety values are not compound masses. DFE/RAE/niacin equivalents are not summed with underlying masses; vitamin D metabolites, K forms and tocopherol/tocotrienol forms remain separate.
57. Combined lutein+zeaxanthin and separate constituents, undifferentiated fatty acids versus specific isomers, and total versus free/added sugars preserve their overlap and definition metadata.
58. Per-100-g food data, grams per 100 g protein and percentage Daily Value cannot be logged as consumed gram amounts without a valid consumed-total contract; no scaling or target inference occurs.
59. Food water in grams is not automatically converted to hydration volume. Dietary versus supplemental nutrient sections and fluid routes retain their stated coverage.
60. A body-composition record preserves region/side, phase-angle frequency, fluid compartments and method. Visceral-fat level is not relabelled as area or percent.
61. DXA site/reference basis and T-score/Z-score distinctions, spirometry observed/predicted values and bronchodilator state, and ECG QTc formula survive corrections and retrieval.
62. CGM summary periods, sample coverage, GMI and supplied band definitions remain attached. GMI is not lab HbA1c; overlapping studies are not spread or averaged as daily values.
63. A scalar projection from a study summary does not generate another stored record or double-count a separately linked alternative observation. Unresolved duplicate representations warn.
64. AHI/REI/RDI and REM/supine sub-indices preserve their denominators and coverage. Oxygen time-below-threshold and ODI definitions stay source metadata, not clinical alert settings.
65. Observed PAP pressure/leak/use values are historical session fields, not a future prescription or device control. Leak percentiles are not mistaken for mean leak.
66. Workout elapsed/moving/pause times, segments, power/mechanical work, and metabolic energy retain their meaning. Laps/intervals are not added to enclosing totals.
67. Strength load per hand/per side/total/assistance, RPE scale and repetitions-in-reserve remain explicit. Cadence in steps, strides and revolutions per minute is not silently interchangeable.
68. Named symptom/assessment scales retain their versions/bounds; an absent boolean is not false. Optional reproductive data is supplied only and does not infer any personal attribute or prediction.
69. Actual administered quantity and package strength are separate. Partial intake is explicit; unknown salt/elemental/IU conversions do not manufacture a nutrient dose or future schedule.
70. Every nested field and discriminator in all eight record schemas is discoverable; group filters and exact field_path lookups return complete definitions with valid local references.
71. All v4 nutrient/analyte keys and valid example writes remain supported under the documented migration policy. Old revisions/idempotency results remain readable and are not validated retroactively as fresh v5 records.
72. Typed custom analytes accept uncommon supplied observations without mutating the registry; different unspecified custom identities/assays do not merge automatically.
73. No new service, frontend, file subsystem, OAuth flow, food provider, user model, targets or estimator is introduced by the expansion. The MCP surface remains sixteen tools.
74. Known incompatible nutrient expression bases return separate subtotals rather than one false total. Unknown-basis amounts are not silently made equivalent to a known analytical or food-component definition.
75. Energy unit normalization selects one representation per record. A kJ daily total overrides the energy concept including kcal intake entries; contradictory dual-unit values suppress an exact total and cannot double-count or be silently resolved.
76. Versioned sources and exact mappings are documented honestly: reviewed sample pages are identified, optional external codes are omitted when unverified, and registry coverage is not represented as completed medical testing or a universally exhaustive clinical vocabulary.

## 12. Extended integration examples and invariants

All examples below are synthetic and describe domain tool arguments. They require the common transport authentication and do not seed data. Implement matching executable fixtures against the final generated schemas; differences in a finalized nested shape must be updated consistently across documentation and tests.

### Discover just the relevant fields

```text
health_get_catalog({"category":"nutrients","group_key":"amino_acids"})
GET /v1/catalog?category=nutrients&group_key=amino_acids

health_get_catalog({"category":"lab_analytes","panel_key":"urine_quantitative"})
GET /v1/catalog?category=lab_analytes&panel_key=urine_quantitative

health_get_catalog({"category":"measurements","group_key":"study_summaries"})
GET /v1/catalog?category=measurements&group_key=study_summaries

health_get_catalog({"category":"record_schemas","key":"sleep","field_path":"/respiratory_events"})
GET /v1/catalog?category=record_schemas&key=sleep&field_path=%2Frespiratory_events
```

The last call returns the respiratory-event object's complete descriptor and nested schema, not a partial record-value lookup. A catalog is identical with an empty or populated health database.

### A nutrition amount that is a limit, not an exact value

Illustrative mutable nutrition `data`:

```json
{
  "entry_kind": "intake",
  "label": "Consumed intake",
  "nutrients": {
    "energy_kcal": 180,
    "protein_g": 9,
    "added_sugars_g": 0.5,
    "fiber_g": null
  },
  "nutrient_qualifiers": {
    "added_sugars_g": {
      "kind": "bound",
      "comparator": "lt",
      "original_value_text": "<0.5 g"
    }
  }
}
```

This reports energy/protein point amounts and an added-sugar upper bound. A normal exact sugar subtotal must not include 0.5 as an observed equality. A day-total upper bound remains the effective qualified whole-day result rather than being replaced by a seemingly precise sum of partial entries.

### Why a reference interval cannot be a universal rule

Two results of the same named analyte may carry different source ranges/methods. Store both supplied ranges alongside their observations and partition numeric series when required. A new report changing its stated range does not rewrite old reference information or diagnose a change in the person.

### Interval-study logging

A `cgm_summary` spanning several dates holds its actual period, coverage and supplied glucose-band definitions in one typed measurement. A daily summary may display a reference to that overlapping study. It must not declare the study's multi-day mean to be that day's actual glucose reading, nor store its printed display bands as personal targets.

### Scope invariant

The server consumes structured values, records them faithfully, and exposes their schemas and history. It does not discover foods, prescribe actions, schedule events, infer missing measurements or run a clinical decision engine. Those are outside the service contract.

## 13. Research basis, source register and evidence limits

Sources were checked on **2 October 2026**. The application identifiers and grouping choices are original implementation requirements, not claims that these names are standardized clinical codes. The reviewed materials support representative field families and semantic distinctions; every possible laboratory assay, nutrient form and device report was not exhaustively verified.

Selected public **sample** laboratory report pages were visually reviewed to identify reporting conventions. No private patient records were researched or copied. Laboratory reference intervals, clinical thresholds, treatments, vendor goals and recommendations found in those sources are intentionally not installed as rules or targets.

The source references below are design-time research evidence. They do not introduce runtime network dependencies, scraping, food-data adapters, synchronization, licensing assumptions for copied datasets or external terminology calls. Optional external code mappings require exact source/version verification and applicable licensing review before being published; no unverified mapping is supplied in the embedded inventory in Appendix A.

The Indian Food Composition Tables coverage check used ICMR-NIN's official descriptive page. The complete IFCT2017 book could not be retrieved for review; therefore this document does not claim a full field-by-field extraction of that publication. Nutrient-form definitions are grounded primarily in accessible USDA, FAO/INFOODS, FDA and NIH materials.

- **[R1] MCP official server tools specification.** Protocol operation schemas and discovery; not a health terminology. Source: `https://modelcontextprotocol.io/specification/2026-07-28/server/tools`
- **[R2] OpenAPI Specification 3.1.1.** Versioned API schema reference, not a claim about the newest OpenAPI release. Source: `https://spec.openapis.org/oas/v3.1.1.html`
- **[S01] USDA FoodData Central Foundation Foods documentation.** Component forms, reporting bases, unavailable nutrients, analytical method distinctions. Source: `https://fdc.nal.usda.gov/Foundation_Foods_Documentation/`
- **[S02] USDA National Agricultural Library: nutrient lists, SR Legacy 2018.** Additional food-component and amino-acid coverage. Historical version, not a live food-data integration. Source: `https://www.nal.usda.gov/human-nutrition-and-food-safety/nutrient-lists-standard-reference-legacy-2018`
- **[S03] FAO/INFOODS food component identifiers.** Precisely distinguish components and expression bases; no unverified tag mappings are required. Source: `https://www.fao.org/infoods/infoods/standards-guidelines/food-component-identifiers-tagnames/en/`
- **[S04] FDA industry resources for Nutrition Facts labels.** Label nutrient families, soluble/insoluble fibre and sugar-alcohol fields; not a labeling-compliance implementation. Source: `https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/industry-resources-changes-nutrition-facts-label`
- **[S05] NIH Office of Dietary Supplements: Folate, health professional.** Folate forms and DFE are not identical quantities. Source: `https://ods.od.nih.gov/factsheets/Folate-HealthProfessional/`
- **[S06] NIH Office of Dietary Supplements: Vitamin A, health professional.** Retinol activity equivalents and carotenoid forms. Source: `https://ods.od.nih.gov/factsheets/VitaminA-HealthProfessional/`
- **[S07] NIH Office of Dietary Supplements: Vitamin E, health professional.** Form-specific vitamin E expression; no generic IU-to-mass conversion. Source: `https://ods.od.nih.gov/factsheets/VitaminE-HealthProfessional/`
- **[S08] ICMR-NIN achievements: Indian Food Composition Tables 2017 description.** Indian-context coverage cross-check. The official descriptive page was reviewed; the full IFCT book was not reviewed. Source: `https://www.nin.res.in/achievements.html`
- **[S09] Dr Lal PathLabs official comprehensive dummy report WM17S.** Selected report pages visually reviewed: chemistry, vitamin tests, HbA1c/eAG, CBC, revised-report notation. No patient values copied. Source: `https://cdn1.lalpathlabs.com/live/reports/WM17S.pdf`
- **[S10] Labcorp comprehensive metabolic panel: test description and sample report.** Panel constituents and reporting conventions; sample first page visually reviewed at https://files.labcorp.com/testmenu-d8/sample_reports/322000.pdf. Source: `https://www.labcorp.com/tests/322000/metabolic-panel-14-comprehensive`
- **[S11] Labcorp comprehensive pre-bariatric profile: test description and sample report.** Broader nutritional/laboratory fields; sample first two pages visually reviewed at https://files.labcorp.com/testmenu-d8/sample_reports/259141.pdf. Not a recommendation to order that profile. Source: `https://www.labcorp.com/tests/259141/pre-bariatric-surgery-comprehensive-profile`
- **[S12] Mayo Clinic Laboratories thyroid function cascade.** Distinct thyroid assays and an official sample report; source sample page visually reviewed. Source: `https://www.mayocliniclabs.com/test-catalog/overview/83633/thyroid-function-cascade-serum`
- **[S13] HL7 FHIR R4 Observation.** Design reference for result variants, absence reasons, components and reference-range context. This service is not a FHIR server. Source: `https://hl7.org/fhir/R4/observation.html`
- **[S14] HL7 FHIR R4 DiagnosticReport.** Report grouping, result status and effective versus issued dates; no document-storage feature. Source: `https://hl7.org/fhir/R4/diagnosticreport.html`
- **[S15] LOINC users guide: major parts of a term.** Analyte/property/time/specimen/scale/method distinctions. Do not publish guessed clinical codes. Source: `https://loinc.org/kb/users-guide/major-parts-of-a-loinc-term`
- **[S16] UCUM specification.** Unit representation and dimensional meaning; assay equivalence must be checked separately. Source: `https://ucum.org/ucum`
- **[S17] International Diabetes Center: AGP report examples.** Interval-based glucose summaries and coverage metadata. Displayed clinical targets are not adopted as application targets. Source: `https://www.agpreport.org/agp/agpreports`
- **[S18] American Thoracic Society: interpreting sleep studies primer.** Sleep-study result families, respiratory indices and oxygen reporting; no diagnostic thresholds adopted. Source: `https://www.thoracic.org/professionals/clinical-resources/sleep/sleep-modules/interpreting-sleep-studies-primer.php`
- **[S19] InBody official result-sheet explanation.** Segmental composition and source-specific body-composition quantities; no vendor score or target claims adopted. Source: `https://www.inbody.in/result-sheet.php`
- **[S20] Garmin official running-dynamics manual.** Running-dynamics measurement families. No wearable integration is required. Source: `https://www8.garmin.com/manuals-apac/webhelp/fenix7series/EN-SG/GUID-0EEB4D15-92ED-48EB-B938-3873B4FD6BA4-8922.html`
- **[S21] HL7 FHIR R4 MedicationAdministration.** Actual administration period, route, dose, site and rate; no prescription planning. Source: `https://hl7.org/fhir/R4/medicationadministration.html`
- **[S22] Labcorp coagulation/DIC profile.** Coagulation analyte family coverage, not a screening recommendation. Source: `https://www.labcorp.com/tests/116012/disseminated-intravascular-coagulation-dic-profile`
- **[S23] Mayo Clinic Laboratories HEp-2 antinuclear antibodies.** Antibody result forms, titers and patterns. Source: `https://www.mayocliniclabs.com/test-catalog/overview/65161/antinuclear-antibodies-hep-2-substrate-igg-serum`
- **[S24] Labcorp gastrointestinal stool PCR profile.** Organism-specific qualitative molecular results. Source: `https://www.labcorp.com/tests/183480/gastrointestinal-profile-stool-pcr`
- **[S25] Labcorp quantitative fecal fat.** Collection duration and excretion-rate versus concentration distinctions. Source: `https://www.labcorp.com/tests/001354/fecal-fat-quantitative`
- **[S26] USDA National Agricultural Library: food composition.** Specialized food-component families, including choline, isoflavones and purines. Source: `https://www.nal.usda.gov/human-nutrition-and-food-safety/food-composition`
- **[S27] ATS/ERS Standardization of Spirometry, 2019 technical statement.** Primary technical statement for spirometry measurement/report structure, not a diagnostic implementation. Source: `https://pmc.ncbi.nlm.nih.gov/articles/PMC6794117/`
- **[S28] International Society for Clinical Densitometry: official adult positions.** DXA site, BMD, T-score/Z-score and report comparability; no clinical thresholds implemented. Source: `https://iscd.org/official-positions-2023/`
- **[S29] Mayo Clinic Laboratories semen analysis with strict morphology.** Semen quantity, motility and morphology are different reported measurements. Source: `https://www.mayocliniclabs.com/test-catalog/overview/60556/semen-analysis-with-strict-morphology-semen`
- **[S30] Labcorp cancer antigen CA 125 test definition.** Assay-specific tumor-marker result identity; inclusion is not a recommendation for screening. Source: `https://www.labcorp.com/tests/002303/cancer-antigen-ca-125`

## 14. Build order and release gate

Keep broad data support separate from system complexity. First establish the shared result/context primitives and registry generation; then implement the eight domain schemas against the full required key inventory; then add the two transport wrappers, deterministic summaries and migration/compatibility tests. No external integration is a prerequisite.

Use schema-driven tests to cover every advertised definition. A category is not implemented merely because its display names appear in the inventory: the write schema, validation, corrected-record handling, discovery descriptor and read/summary policy must agree. Unsupported calculations must remain explicitly unsupported rather than filled in with heuristic values.

Publish a machine-readable coverage report naming implemented definitions, tested examples, API/MCP contract parity and any remaining unsupported branches. Do not advertise a stubbed category as supported. Run and report actual tests before claiming the service is ready; this design document and its static inventory checks are not evidence that a running API has passed its acceptance tests.

---

## Appendix A — Embedded field inventory

The following JSON is the complete machine-readable field inventory for this specification. It is included in full so an implementation agent needs only this document. It contains the exact nutrient identifiers, laboratory panel memberships and analyte definitions, measurement groups, record-field index, and source references.

Use this inventory as the implementation coverage checklist. It is not an executable runtime schema or evidence of deployed capabilities. The numbered specification sections define semantics and constraints; generate runtime validation, MCP schemas, OpenAPI schemas, and discovery responses from the implemented shared registry as required above.

```json
{
  "artifact_kind": "implementation_field_inventory_not_deployed_runtime_schema",
  "specification_revision": 5,
  "research_checked_on": "2026-10-02",
  "purpose": "Exact required application keys and grouping memberships for implementation. Does not claim universal clinical coverage or a verified standard-code map.",
  "compatibility": "Retains every v4 nutrient and built-in analyte key. Existing ambiguous definitions remain qualified rather than silently reassigned.",
  "counts": {
    "nutrient_keys": 182,
    "nutrient_groups": 11,
    "lab_analyte_keys": 424,
    "lab_panel_groups": 30,
    "measurement_keys": 110,
    "measurement_groups": 8,
    "record_types": 8,
    "mcp_tools": 16
  },
  "nutrient_groups": {
    "energy_proximates": [
      "energy_kcal",
      "energy_kj",
      "protein_g",
      "fat_g",
      "carbohydrate_g",
      "water_g",
      "ash_g",
      "nitrogen_g",
      "alcohol_g"
    ],
    "carbohydrates_fiber_sugars": [
      "available_carbohydrate_g",
      "carbohydrate_by_difference_g",
      "starch_g",
      "resistant_starch_g",
      "fiber_g",
      "soluble_fiber_g",
      "insoluble_fiber_g",
      "beta_glucan_g",
      "inulin_g",
      "fructooligosaccharides_g",
      "galactooligosaccharides_g",
      "total_sugars_g",
      "added_sugars_g",
      "free_sugars_g",
      "glucose_g",
      "fructose_g",
      "galactose_g",
      "sucrose_g",
      "lactose_g",
      "maltose_g",
      "trehalose_g",
      "allulose_g",
      "total_sugar_alcohols_g",
      "erythritol_g",
      "sorbitol_g",
      "mannitol_g",
      "xylitol_g",
      "maltitol_g",
      "lactitol_g",
      "isomalt_g"
    ],
    "fat_classes": [
      "saturated_fat_g",
      "trans_fat_g",
      "monounsaturated_fat_g",
      "polyunsaturated_fat_g",
      "omega_3_g",
      "omega_6_g",
      "omega_9_g",
      "epa_dha_g",
      "cholesterol_mg"
    ],
    "fatty_acids": [
      "butyric_acid_g",
      "caproic_acid_g",
      "caprylic_acid_g",
      "capric_acid_g",
      "lauric_acid_g",
      "myristic_acid_g",
      "palmitic_acid_g",
      "stearic_acid_g",
      "arachidic_acid_g",
      "behenic_acid_g",
      "lignoceric_acid_g",
      "palmitoleic_acid_g",
      "oleic_acid_g",
      "eicosenoic_acid_g",
      "erucic_acid_g",
      "nervonic_acid_g",
      "linoleic_acid_g",
      "ala_g",
      "gamma_linolenic_acid_g",
      "arachidonic_acid_g",
      "epa_g",
      "dpa_n3_g",
      "dha_g",
      "cla_g",
      "fatty_acid_16_1_undifferentiated_g",
      "fatty_acid_18_1_undifferentiated_g",
      "fatty_acid_18_2_undifferentiated_g",
      "fatty_acid_18_3_undifferentiated_g"
    ],
    "amino_acids": [
      "bcaa_g",
      "alanine_g",
      "arginine_g",
      "aspartic_acid_g",
      "asparagine_g",
      "cysteine_g",
      "cystine_g",
      "glutamic_acid_g",
      "glutamine_g",
      "glycine_g",
      "histidine_g",
      "isoleucine_g",
      "leucine_g",
      "lysine_g",
      "methionine_g",
      "phenylalanine_g",
      "proline_g",
      "serine_g",
      "threonine_g",
      "tryptophan_g",
      "tyrosine_g",
      "valine_g",
      "hydroxyproline_g",
      "taurine_g"
    ],
    "minerals_trace_elements": [
      "sodium_mg",
      "potassium_mg",
      "calcium_mg",
      "magnesium_mg",
      "phosphorus_mg",
      "iron_mg",
      "zinc_mg",
      "copper_mg",
      "manganese_mg",
      "selenium_ug",
      "iodine_ug",
      "chloride_mg",
      "salt_g",
      "salt_equivalent_g",
      "chromium_ug",
      "molybdenum_ug",
      "fluoride_mg",
      "boron_mg",
      "cobalt_ug",
      "nickel_ug",
      "sulfur_mg"
    ],
    "vitamin_a_carotenoids": [
      "vitamin_a_rae_ug",
      "retinol_ug",
      "alpha_carotene_ug",
      "beta_carotene_ug",
      "beta_cryptoxanthin_ug",
      "lycopene_ug",
      "lutein_ug",
      "zeaxanthin_ug",
      "lutein_zeaxanthin_ug"
    ],
    "vitamin_d_e_k_forms": [
      "vitamin_d_ug",
      "vitamin_d2_ug",
      "vitamin_d3_ug",
      "vitamin_d_25_oh_d3_ug",
      "vitamin_e_alpha_tocopherol_mg",
      "beta_tocopherol_mg",
      "gamma_tocopherol_mg",
      "delta_tocopherol_mg",
      "alpha_tocotrienol_mg",
      "beta_tocotrienol_mg",
      "gamma_tocotrienol_mg",
      "delta_tocotrienol_mg",
      "vitamin_k_ug",
      "vitamin_k1_ug",
      "dihydrophylloquinone_ug",
      "vitamin_k2_mk4_ug",
      "vitamin_k2_mk7_ug"
    ],
    "water_soluble_vitamins": [
      "vitamin_c_mg",
      "thiamin_b1_mg",
      "riboflavin_b2_mg",
      "niacin_b3_mg",
      "niacin_equivalents_mg",
      "pantothenic_acid_b5_mg",
      "vitamin_b6_mg",
      "biotin_b7_ug",
      "folate_ug",
      "folate_dfe_ug",
      "food_folate_ug",
      "folic_acid_ug",
      "five_mthf_ug",
      "vitamin_b12_ug"
    ],
    "choline_related": [
      "choline_mg",
      "choline_free_mg",
      "choline_from_glycerophosphocholine_mg",
      "choline_from_phosphocholine_mg",
      "choline_from_phosphatidylcholine_mg",
      "choline_from_sphingomyelin_mg",
      "betaine_mg"
    ],
    "other_food_components": [
      "caffeine_mg",
      "theobromine_mg",
      "phytosterols_mg",
      "beta_sitosterol_mg",
      "campesterol_mg",
      "stigmasterol_mg",
      "total_isoflavones_mg",
      "daidzein_mg",
      "genistein_mg",
      "glycitein_mg",
      "total_oxalate_mg",
      "soluble_oxalate_mg",
      "phytate_mg",
      "total_purines_mg"
    ]
  },
  "nutrient_entries": [
    {
      "key": "energy_kcal",
      "group_key": "energy_proximates",
      "unit": "kcal",
      "field_path": "/nutrients/energy_kcal",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/energy_kcal",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "energy_kj",
      "group_key": "energy_proximates",
      "unit": "kJ",
      "field_path": "/nutrients/energy_kj",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/energy_kj",
      "notes": "Alternate energy representation; do not sum with energy_kcal."
    },
    {
      "key": "protein_g",
      "group_key": "energy_proximates",
      "unit": "g",
      "field_path": "/nutrients/protein_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/protein_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "fat_g",
      "group_key": "energy_proximates",
      "unit": "g",
      "field_path": "/nutrients/fat_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/fat_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "carbohydrate_g",
      "group_key": "energy_proximates",
      "unit": "g",
      "field_path": "/nutrients/carbohydrate_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/carbohydrate_g",
      "notes": "Reported carbohydrate with explicit supplied/unknown definition; do not silently redefine legacy records."
    },
    {
      "key": "water_g",
      "group_key": "energy_proximates",
      "unit": "g",
      "field_path": "/nutrients/water_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/water_g",
      "notes": "Water content by mass in consumed food/intake; not a duplicate hydration-volume entry."
    },
    {
      "key": "ash_g",
      "group_key": "energy_proximates",
      "unit": "g",
      "field_path": "/nutrients/ash_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/ash_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "nitrogen_g",
      "group_key": "energy_proximates",
      "unit": "g",
      "field_path": "/nutrients/nitrogen_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/nitrogen_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "alcohol_g",
      "group_key": "energy_proximates",
      "unit": "g",
      "field_path": "/nutrients/alcohol_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/alcohol_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "available_carbohydrate_g",
      "group_key": "carbohydrates_fiber_sugars",
      "unit": "g",
      "field_path": "/nutrients/available_carbohydrate_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/available_carbohydrate_g",
      "notes": "Available carbohydrate; distinguish analytical/expression basis in component_details."
    },
    {
      "key": "carbohydrate_by_difference_g",
      "group_key": "carbohydrates_fiber_sugars",
      "unit": "g",
      "field_path": "/nutrients/carbohydrate_by_difference_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/carbohydrate_by_difference_g",
      "notes": "Carbohydrate-by-difference definition; not additional carbohydrate."
    },
    {
      "key": "starch_g",
      "group_key": "carbohydrates_fiber_sugars",
      "unit": "g",
      "field_path": "/nutrients/starch_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/starch_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "resistant_starch_g",
      "group_key": "carbohydrates_fiber_sugars",
      "unit": "g",
      "field_path": "/nutrients/resistant_starch_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/resistant_starch_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "fiber_g",
      "group_key": "carbohydrates_fiber_sugars",
      "unit": "g",
      "field_path": "/nutrients/fiber_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/fiber_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "soluble_fiber_g",
      "group_key": "carbohydrates_fiber_sugars",
      "unit": "g",
      "field_path": "/nutrients/soluble_fiber_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/soluble_fiber_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "insoluble_fiber_g",
      "group_key": "carbohydrates_fiber_sugars",
      "unit": "g",
      "field_path": "/nutrients/insoluble_fiber_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/insoluble_fiber_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "beta_glucan_g",
      "group_key": "carbohydrates_fiber_sugars",
      "unit": "g",
      "field_path": "/nutrients/beta_glucan_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/beta_glucan_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "inulin_g",
      "group_key": "carbohydrates_fiber_sugars",
      "unit": "g",
      "field_path": "/nutrients/inulin_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/inulin_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "fructooligosaccharides_g",
      "group_key": "carbohydrates_fiber_sugars",
      "unit": "g",
      "field_path": "/nutrients/fructooligosaccharides_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/fructooligosaccharides_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "galactooligosaccharides_g",
      "group_key": "carbohydrates_fiber_sugars",
      "unit": "g",
      "field_path": "/nutrients/galactooligosaccharides_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/galactooligosaccharides_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "total_sugars_g",
      "group_key": "carbohydrates_fiber_sugars",
      "unit": "g",
      "field_path": "/nutrients/total_sugars_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/total_sugars_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "added_sugars_g",
      "group_key": "carbohydrates_fiber_sugars",
      "unit": "g",
      "field_path": "/nutrients/added_sugars_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/added_sugars_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "free_sugars_g",
      "group_key": "carbohydrates_fiber_sugars",
      "unit": "g",
      "field_path": "/nutrients/free_sugars_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/free_sugars_g",
      "notes": "Supplied free-sugar quantity with source definition; not interchangeable with added sugars."
    },
    {
      "key": "glucose_g",
      "group_key": "carbohydrates_fiber_sugars",
      "unit": "g",
      "field_path": "/nutrients/glucose_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/glucose_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "fructose_g",
      "group_key": "carbohydrates_fiber_sugars",
      "unit": "g",
      "field_path": "/nutrients/fructose_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/fructose_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "galactose_g",
      "group_key": "carbohydrates_fiber_sugars",
      "unit": "g",
      "field_path": "/nutrients/galactose_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/galactose_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "sucrose_g",
      "group_key": "carbohydrates_fiber_sugars",
      "unit": "g",
      "field_path": "/nutrients/sucrose_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/sucrose_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "lactose_g",
      "group_key": "carbohydrates_fiber_sugars",
      "unit": "g",
      "field_path": "/nutrients/lactose_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/lactose_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "maltose_g",
      "group_key": "carbohydrates_fiber_sugars",
      "unit": "g",
      "field_path": "/nutrients/maltose_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/maltose_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "trehalose_g",
      "group_key": "carbohydrates_fiber_sugars",
      "unit": "g",
      "field_path": "/nutrients/trehalose_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/trehalose_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "allulose_g",
      "group_key": "carbohydrates_fiber_sugars",
      "unit": "g",
      "field_path": "/nutrients/allulose_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/allulose_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "total_sugar_alcohols_g",
      "group_key": "carbohydrates_fiber_sugars",
      "unit": "g",
      "field_path": "/nutrients/total_sugar_alcohols_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/total_sugar_alcohols_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "erythritol_g",
      "group_key": "carbohydrates_fiber_sugars",
      "unit": "g",
      "field_path": "/nutrients/erythritol_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/erythritol_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "sorbitol_g",
      "group_key": "carbohydrates_fiber_sugars",
      "unit": "g",
      "field_path": "/nutrients/sorbitol_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/sorbitol_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "mannitol_g",
      "group_key": "carbohydrates_fiber_sugars",
      "unit": "g",
      "field_path": "/nutrients/mannitol_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/mannitol_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "xylitol_g",
      "group_key": "carbohydrates_fiber_sugars",
      "unit": "g",
      "field_path": "/nutrients/xylitol_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/xylitol_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "maltitol_g",
      "group_key": "carbohydrates_fiber_sugars",
      "unit": "g",
      "field_path": "/nutrients/maltitol_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/maltitol_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "lactitol_g",
      "group_key": "carbohydrates_fiber_sugars",
      "unit": "g",
      "field_path": "/nutrients/lactitol_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/lactitol_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "isomalt_g",
      "group_key": "carbohydrates_fiber_sugars",
      "unit": "g",
      "field_path": "/nutrients/isomalt_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/isomalt_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "saturated_fat_g",
      "group_key": "fat_classes",
      "unit": "g",
      "field_path": "/nutrients/saturated_fat_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/saturated_fat_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "trans_fat_g",
      "group_key": "fat_classes",
      "unit": "g",
      "field_path": "/nutrients/trans_fat_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/trans_fat_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "monounsaturated_fat_g",
      "group_key": "fat_classes",
      "unit": "g",
      "field_path": "/nutrients/monounsaturated_fat_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/monounsaturated_fat_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "polyunsaturated_fat_g",
      "group_key": "fat_classes",
      "unit": "g",
      "field_path": "/nutrients/polyunsaturated_fat_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/polyunsaturated_fat_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "omega_3_g",
      "group_key": "fat_classes",
      "unit": "g",
      "field_path": "/nutrients/omega_3_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/omega_3_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "omega_6_g",
      "group_key": "fat_classes",
      "unit": "g",
      "field_path": "/nutrients/omega_6_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/omega_6_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "omega_9_g",
      "group_key": "fat_classes",
      "unit": "g",
      "field_path": "/nutrients/omega_9_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/omega_9_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "epa_dha_g",
      "group_key": "fat_classes",
      "unit": "g",
      "field_path": "/nutrients/epa_dha_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/epa_dha_g",
      "notes": "Reported combined EPA plus DHA mass; do not add the separate components again or split an unknown mixture."
    },
    {
      "key": "cholesterol_mg",
      "group_key": "fat_classes",
      "unit": "mg",
      "field_path": "/nutrients/cholesterol_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/cholesterol_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "butyric_acid_g",
      "group_key": "fatty_acids",
      "unit": "g",
      "field_path": "/nutrients/butyric_acid_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/butyric_acid_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "caproic_acid_g",
      "group_key": "fatty_acids",
      "unit": "g",
      "field_path": "/nutrients/caproic_acid_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/caproic_acid_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "caprylic_acid_g",
      "group_key": "fatty_acids",
      "unit": "g",
      "field_path": "/nutrients/caprylic_acid_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/caprylic_acid_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "capric_acid_g",
      "group_key": "fatty_acids",
      "unit": "g",
      "field_path": "/nutrients/capric_acid_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/capric_acid_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "lauric_acid_g",
      "group_key": "fatty_acids",
      "unit": "g",
      "field_path": "/nutrients/lauric_acid_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/lauric_acid_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "myristic_acid_g",
      "group_key": "fatty_acids",
      "unit": "g",
      "field_path": "/nutrients/myristic_acid_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/myristic_acid_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "palmitic_acid_g",
      "group_key": "fatty_acids",
      "unit": "g",
      "field_path": "/nutrients/palmitic_acid_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/palmitic_acid_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "stearic_acid_g",
      "group_key": "fatty_acids",
      "unit": "g",
      "field_path": "/nutrients/stearic_acid_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/stearic_acid_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "arachidic_acid_g",
      "group_key": "fatty_acids",
      "unit": "g",
      "field_path": "/nutrients/arachidic_acid_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/arachidic_acid_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "behenic_acid_g",
      "group_key": "fatty_acids",
      "unit": "g",
      "field_path": "/nutrients/behenic_acid_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/behenic_acid_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "lignoceric_acid_g",
      "group_key": "fatty_acids",
      "unit": "g",
      "field_path": "/nutrients/lignoceric_acid_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/lignoceric_acid_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "palmitoleic_acid_g",
      "group_key": "fatty_acids",
      "unit": "g",
      "field_path": "/nutrients/palmitoleic_acid_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/palmitoleic_acid_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "oleic_acid_g",
      "group_key": "fatty_acids",
      "unit": "g",
      "field_path": "/nutrients/oleic_acid_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/oleic_acid_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "eicosenoic_acid_g",
      "group_key": "fatty_acids",
      "unit": "g",
      "field_path": "/nutrients/eicosenoic_acid_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/eicosenoic_acid_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "erucic_acid_g",
      "group_key": "fatty_acids",
      "unit": "g",
      "field_path": "/nutrients/erucic_acid_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/erucic_acid_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "nervonic_acid_g",
      "group_key": "fatty_acids",
      "unit": "g",
      "field_path": "/nutrients/nervonic_acid_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/nervonic_acid_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "linoleic_acid_g",
      "group_key": "fatty_acids",
      "unit": "g",
      "field_path": "/nutrients/linoleic_acid_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/linoleic_acid_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "ala_g",
      "group_key": "fatty_acids",
      "unit": "g",
      "field_path": "/nutrients/ala_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/ala_g",
      "notes": "Alpha-linolenic acid; isomer-specific, not all 18:3 fatty acids."
    },
    {
      "key": "gamma_linolenic_acid_g",
      "group_key": "fatty_acids",
      "unit": "g",
      "field_path": "/nutrients/gamma_linolenic_acid_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/gamma_linolenic_acid_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "arachidonic_acid_g",
      "group_key": "fatty_acids",
      "unit": "g",
      "field_path": "/nutrients/arachidonic_acid_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/arachidonic_acid_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "epa_g",
      "group_key": "fatty_acids",
      "unit": "g",
      "field_path": "/nutrients/epa_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/epa_g",
      "notes": "Eicosapentaenoic acid, 20:5 n-3."
    },
    {
      "key": "dpa_n3_g",
      "group_key": "fatty_acids",
      "unit": "g",
      "field_path": "/nutrients/dpa_n3_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/dpa_n3_g",
      "notes": "Docosapentaenoic acid n-3; do not conflate n-6 forms."
    },
    {
      "key": "dha_g",
      "group_key": "fatty_acids",
      "unit": "g",
      "field_path": "/nutrients/dha_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/dha_g",
      "notes": "Docosahexaenoic acid, 22:6 n-3."
    },
    {
      "key": "cla_g",
      "group_key": "fatty_acids",
      "unit": "g",
      "field_path": "/nutrients/cla_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/cla_g",
      "notes": "Reported conjugated linoleic acid total; retain isomer context."
    },
    {
      "key": "fatty_acid_16_1_undifferentiated_g",
      "group_key": "fatty_acids",
      "unit": "g",
      "field_path": "/nutrients/fatty_acid_16_1_undifferentiated_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/fatty_acid_16_1_undifferentiated_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "fatty_acid_18_1_undifferentiated_g",
      "group_key": "fatty_acids",
      "unit": "g",
      "field_path": "/nutrients/fatty_acid_18_1_undifferentiated_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/fatty_acid_18_1_undifferentiated_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "fatty_acid_18_2_undifferentiated_g",
      "group_key": "fatty_acids",
      "unit": "g",
      "field_path": "/nutrients/fatty_acid_18_2_undifferentiated_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/fatty_acid_18_2_undifferentiated_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "fatty_acid_18_3_undifferentiated_g",
      "group_key": "fatty_acids",
      "unit": "g",
      "field_path": "/nutrients/fatty_acid_18_3_undifferentiated_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/fatty_acid_18_3_undifferentiated_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "bcaa_g",
      "group_key": "amino_acids",
      "unit": "g",
      "field_path": "/nutrients/bcaa_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/bcaa_g",
      "notes": "Reported branched-chain amino-acid combined mass; do not add component leucine/isoleucine/valine again or infer the mixture."
    },
    {
      "key": "alanine_g",
      "group_key": "amino_acids",
      "unit": "g",
      "field_path": "/nutrients/alanine_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/alanine_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "arginine_g",
      "group_key": "amino_acids",
      "unit": "g",
      "field_path": "/nutrients/arginine_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/arginine_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "aspartic_acid_g",
      "group_key": "amino_acids",
      "unit": "g",
      "field_path": "/nutrients/aspartic_acid_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/aspartic_acid_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "asparagine_g",
      "group_key": "amino_acids",
      "unit": "g",
      "field_path": "/nutrients/asparagine_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/asparagine_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "cysteine_g",
      "group_key": "amino_acids",
      "unit": "g",
      "field_path": "/nutrients/cysteine_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/cysteine_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "cystine_g",
      "group_key": "amino_acids",
      "unit": "g",
      "field_path": "/nutrients/cystine_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/cystine_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "glutamic_acid_g",
      "group_key": "amino_acids",
      "unit": "g",
      "field_path": "/nutrients/glutamic_acid_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/glutamic_acid_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "glutamine_g",
      "group_key": "amino_acids",
      "unit": "g",
      "field_path": "/nutrients/glutamine_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/glutamine_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "glycine_g",
      "group_key": "amino_acids",
      "unit": "g",
      "field_path": "/nutrients/glycine_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/glycine_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "histidine_g",
      "group_key": "amino_acids",
      "unit": "g",
      "field_path": "/nutrients/histidine_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/histidine_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "isoleucine_g",
      "group_key": "amino_acids",
      "unit": "g",
      "field_path": "/nutrients/isoleucine_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/isoleucine_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "leucine_g",
      "group_key": "amino_acids",
      "unit": "g",
      "field_path": "/nutrients/leucine_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/leucine_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "lysine_g",
      "group_key": "amino_acids",
      "unit": "g",
      "field_path": "/nutrients/lysine_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/lysine_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "methionine_g",
      "group_key": "amino_acids",
      "unit": "g",
      "field_path": "/nutrients/methionine_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/methionine_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "phenylalanine_g",
      "group_key": "amino_acids",
      "unit": "g",
      "field_path": "/nutrients/phenylalanine_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/phenylalanine_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "proline_g",
      "group_key": "amino_acids",
      "unit": "g",
      "field_path": "/nutrients/proline_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/proline_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "serine_g",
      "group_key": "amino_acids",
      "unit": "g",
      "field_path": "/nutrients/serine_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/serine_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "threonine_g",
      "group_key": "amino_acids",
      "unit": "g",
      "field_path": "/nutrients/threonine_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/threonine_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "tryptophan_g",
      "group_key": "amino_acids",
      "unit": "g",
      "field_path": "/nutrients/tryptophan_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/tryptophan_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "tyrosine_g",
      "group_key": "amino_acids",
      "unit": "g",
      "field_path": "/nutrients/tyrosine_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/tyrosine_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "valine_g",
      "group_key": "amino_acids",
      "unit": "g",
      "field_path": "/nutrients/valine_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/valine_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "hydroxyproline_g",
      "group_key": "amino_acids",
      "unit": "g",
      "field_path": "/nutrients/hydroxyproline_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/hydroxyproline_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "taurine_g",
      "group_key": "amino_acids",
      "unit": "g",
      "field_path": "/nutrients/taurine_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/taurine_g",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "sodium_mg",
      "group_key": "minerals_trace_elements",
      "unit": "mg",
      "field_path": "/nutrients/sodium_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/sodium_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "potassium_mg",
      "group_key": "minerals_trace_elements",
      "unit": "mg",
      "field_path": "/nutrients/potassium_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/potassium_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "calcium_mg",
      "group_key": "minerals_trace_elements",
      "unit": "mg",
      "field_path": "/nutrients/calcium_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/calcium_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "magnesium_mg",
      "group_key": "minerals_trace_elements",
      "unit": "mg",
      "field_path": "/nutrients/magnesium_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/magnesium_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "phosphorus_mg",
      "group_key": "minerals_trace_elements",
      "unit": "mg",
      "field_path": "/nutrients/phosphorus_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/phosphorus_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "iron_mg",
      "group_key": "minerals_trace_elements",
      "unit": "mg",
      "field_path": "/nutrients/iron_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/iron_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "zinc_mg",
      "group_key": "minerals_trace_elements",
      "unit": "mg",
      "field_path": "/nutrients/zinc_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/zinc_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "copper_mg",
      "group_key": "minerals_trace_elements",
      "unit": "mg",
      "field_path": "/nutrients/copper_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/copper_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "manganese_mg",
      "group_key": "minerals_trace_elements",
      "unit": "mg",
      "field_path": "/nutrients/manganese_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/manganese_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "selenium_ug",
      "group_key": "minerals_trace_elements",
      "unit": "ug",
      "field_path": "/nutrients/selenium_ug",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/selenium_ug",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "iodine_ug",
      "group_key": "minerals_trace_elements",
      "unit": "ug",
      "field_path": "/nutrients/iodine_ug",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/iodine_ug",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "chloride_mg",
      "group_key": "minerals_trace_elements",
      "unit": "mg",
      "field_path": "/nutrients/chloride_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/chloride_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "salt_g",
      "group_key": "minerals_trace_elements",
      "unit": "g",
      "field_path": "/nutrients/salt_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/salt_g",
      "notes": "Reported salt mass with explicitly supplied or unknown substance/basis; do not infer sodium."
    },
    {
      "key": "salt_equivalent_g",
      "group_key": "minerals_trace_elements",
      "unit": "g",
      "field_path": "/nutrients/salt_equivalent_g",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/salt_equivalent_g",
      "notes": "Declared salt-equivalent expression; not additional salt or sodium, and not a target."
    },
    {
      "key": "chromium_ug",
      "group_key": "minerals_trace_elements",
      "unit": "ug",
      "field_path": "/nutrients/chromium_ug",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/chromium_ug",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "molybdenum_ug",
      "group_key": "minerals_trace_elements",
      "unit": "ug",
      "field_path": "/nutrients/molybdenum_ug",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/molybdenum_ug",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "fluoride_mg",
      "group_key": "minerals_trace_elements",
      "unit": "mg",
      "field_path": "/nutrients/fluoride_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/fluoride_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "boron_mg",
      "group_key": "minerals_trace_elements",
      "unit": "mg",
      "field_path": "/nutrients/boron_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/boron_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "cobalt_ug",
      "group_key": "minerals_trace_elements",
      "unit": "ug",
      "field_path": "/nutrients/cobalt_ug",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/cobalt_ug",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "nickel_ug",
      "group_key": "minerals_trace_elements",
      "unit": "ug",
      "field_path": "/nutrients/nickel_ug",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/nickel_ug",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "sulfur_mg",
      "group_key": "minerals_trace_elements",
      "unit": "mg",
      "field_path": "/nutrients/sulfur_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/sulfur_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "vitamin_a_rae_ug",
      "group_key": "vitamin_a_carotenoids",
      "unit": "ug",
      "field_path": "/nutrients/vitamin_a_rae_ug",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/vitamin_a_rae_ug",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "retinol_ug",
      "group_key": "vitamin_a_carotenoids",
      "unit": "ug",
      "field_path": "/nutrients/retinol_ug",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/retinol_ug",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "alpha_carotene_ug",
      "group_key": "vitamin_a_carotenoids",
      "unit": "ug",
      "field_path": "/nutrients/alpha_carotene_ug",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/alpha_carotene_ug",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "beta_carotene_ug",
      "group_key": "vitamin_a_carotenoids",
      "unit": "ug",
      "field_path": "/nutrients/beta_carotene_ug",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/beta_carotene_ug",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "beta_cryptoxanthin_ug",
      "group_key": "vitamin_a_carotenoids",
      "unit": "ug",
      "field_path": "/nutrients/beta_cryptoxanthin_ug",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/beta_cryptoxanthin_ug",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "lycopene_ug",
      "group_key": "vitamin_a_carotenoids",
      "unit": "ug",
      "field_path": "/nutrients/lycopene_ug",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/lycopene_ug",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "lutein_ug",
      "group_key": "vitamin_a_carotenoids",
      "unit": "ug",
      "field_path": "/nutrients/lutein_ug",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/lutein_ug",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "zeaxanthin_ug",
      "group_key": "vitamin_a_carotenoids",
      "unit": "ug",
      "field_path": "/nutrients/zeaxanthin_ug",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/zeaxanthin_ug",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "lutein_zeaxanthin_ug",
      "group_key": "vitamin_a_carotenoids",
      "unit": "ug",
      "field_path": "/nutrients/lutein_zeaxanthin_ug",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/lutein_zeaxanthin_ug",
      "notes": "Combined measurement; do not add the separate lutein and zeaxanthin fields again."
    },
    {
      "key": "vitamin_d_ug",
      "group_key": "vitamin_d_e_k_forms",
      "unit": "ug",
      "field_path": "/nutrients/vitamin_d_ug",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/vitamin_d_ug",
      "notes": "Reported vitamin D total with preserved definition; do not automatically include 25-hydroxy D3."
    },
    {
      "key": "vitamin_d2_ug",
      "group_key": "vitamin_d_e_k_forms",
      "unit": "ug",
      "field_path": "/nutrients/vitamin_d2_ug",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/vitamin_d2_ug",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "vitamin_d3_ug",
      "group_key": "vitamin_d_e_k_forms",
      "unit": "ug",
      "field_path": "/nutrients/vitamin_d3_ug",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/vitamin_d3_ug",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "vitamin_d_25_oh_d3_ug",
      "group_key": "vitamin_d_e_k_forms",
      "unit": "ug",
      "field_path": "/nutrients/vitamin_d_25_oh_d3_ug",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/vitamin_d_25_oh_d3_ug",
      "notes": "25-hydroxycholecalciferol content; separate from ordinary vitamin D2/D3 total."
    },
    {
      "key": "vitamin_e_alpha_tocopherol_mg",
      "group_key": "vitamin_d_e_k_forms",
      "unit": "mg",
      "field_path": "/nutrients/vitamin_e_alpha_tocopherol_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/vitamin_e_alpha_tocopherol_mg",
      "notes": "Alpha-tocopherol reporting basis; preserve source form/activity context."
    },
    {
      "key": "beta_tocopherol_mg",
      "group_key": "vitamin_d_e_k_forms",
      "unit": "mg",
      "field_path": "/nutrients/beta_tocopherol_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/beta_tocopherol_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "gamma_tocopherol_mg",
      "group_key": "vitamin_d_e_k_forms",
      "unit": "mg",
      "field_path": "/nutrients/gamma_tocopherol_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/gamma_tocopherol_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "delta_tocopherol_mg",
      "group_key": "vitamin_d_e_k_forms",
      "unit": "mg",
      "field_path": "/nutrients/delta_tocopherol_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/delta_tocopherol_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "alpha_tocotrienol_mg",
      "group_key": "vitamin_d_e_k_forms",
      "unit": "mg",
      "field_path": "/nutrients/alpha_tocotrienol_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/alpha_tocotrienol_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "beta_tocotrienol_mg",
      "group_key": "vitamin_d_e_k_forms",
      "unit": "mg",
      "field_path": "/nutrients/beta_tocotrienol_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/beta_tocotrienol_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "gamma_tocotrienol_mg",
      "group_key": "vitamin_d_e_k_forms",
      "unit": "mg",
      "field_path": "/nutrients/gamma_tocotrienol_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/gamma_tocotrienol_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "delta_tocotrienol_mg",
      "group_key": "vitamin_d_e_k_forms",
      "unit": "mg",
      "field_path": "/nutrients/delta_tocotrienol_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/delta_tocotrienol_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "vitamin_k_ug",
      "group_key": "vitamin_d_e_k_forms",
      "unit": "ug",
      "field_path": "/nutrients/vitamin_k_ug",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/vitamin_k_ug",
      "notes": "Reported vitamin K with supplied/unknown form; do not assume K1."
    },
    {
      "key": "vitamin_k1_ug",
      "group_key": "vitamin_d_e_k_forms",
      "unit": "ug",
      "field_path": "/nutrients/vitamin_k1_ug",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/vitamin_k1_ug",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "dihydrophylloquinone_ug",
      "group_key": "vitamin_d_e_k_forms",
      "unit": "ug",
      "field_path": "/nutrients/dihydrophylloquinone_ug",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/dihydrophylloquinone_ug",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "vitamin_k2_mk4_ug",
      "group_key": "vitamin_d_e_k_forms",
      "unit": "ug",
      "field_path": "/nutrients/vitamin_k2_mk4_ug",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/vitamin_k2_mk4_ug",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "vitamin_k2_mk7_ug",
      "group_key": "vitamin_d_e_k_forms",
      "unit": "ug",
      "field_path": "/nutrients/vitamin_k2_mk7_ug",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/vitamin_k2_mk7_ug",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "vitamin_c_mg",
      "group_key": "water_soluble_vitamins",
      "unit": "mg",
      "field_path": "/nutrients/vitamin_c_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/vitamin_c_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "thiamin_b1_mg",
      "group_key": "water_soluble_vitamins",
      "unit": "mg",
      "field_path": "/nutrients/thiamin_b1_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/thiamin_b1_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "riboflavin_b2_mg",
      "group_key": "water_soluble_vitamins",
      "unit": "mg",
      "field_path": "/nutrients/riboflavin_b2_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/riboflavin_b2_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "niacin_b3_mg",
      "group_key": "water_soluble_vitamins",
      "unit": "mg",
      "field_path": "/nutrients/niacin_b3_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/niacin_b3_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "niacin_equivalents_mg",
      "group_key": "water_soluble_vitamins",
      "unit": "mg",
      "field_path": "/nutrients/niacin_equivalents_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/niacin_equivalents_mg",
      "notes": "Niacin-equivalent reporting basis, not additional niacin mass."
    },
    {
      "key": "pantothenic_acid_b5_mg",
      "group_key": "water_soluble_vitamins",
      "unit": "mg",
      "field_path": "/nutrients/pantothenic_acid_b5_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/pantothenic_acid_b5_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "vitamin_b6_mg",
      "group_key": "water_soluble_vitamins",
      "unit": "mg",
      "field_path": "/nutrients/vitamin_b6_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/vitamin_b6_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "biotin_b7_ug",
      "group_key": "water_soluble_vitamins",
      "unit": "ug",
      "field_path": "/nutrients/biotin_b7_ug",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/biotin_b7_ug",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "folate_ug",
      "group_key": "water_soluble_vitamins",
      "unit": "ug",
      "field_path": "/nutrients/folate_ug",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/folate_ug",
      "notes": "Reported folate mass under supplied/unknown definition; distinct from DFE."
    },
    {
      "key": "folate_dfe_ug",
      "group_key": "water_soluble_vitamins",
      "unit": "ug",
      "field_path": "/nutrients/folate_dfe_ug",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/folate_dfe_ug",
      "notes": "Dietary folate equivalents, not additional folate mass."
    },
    {
      "key": "food_folate_ug",
      "group_key": "water_soluble_vitamins",
      "unit": "ug",
      "field_path": "/nutrients/food_folate_ug",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/food_folate_ug",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "folic_acid_ug",
      "group_key": "water_soluble_vitamins",
      "unit": "ug",
      "field_path": "/nutrients/folic_acid_ug",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/folic_acid_ug",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "five_mthf_ug",
      "group_key": "water_soluble_vitamins",
      "unit": "ug",
      "field_path": "/nutrients/five_mthf_ug",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/five_mthf_ug",
      "notes": "Mass of 5-methyltetrahydrofolate moiety, not salt mass or DFE."
    },
    {
      "key": "vitamin_b12_ug",
      "group_key": "water_soluble_vitamins",
      "unit": "ug",
      "field_path": "/nutrients/vitamin_b12_ug",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/vitamin_b12_ug",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "choline_mg",
      "group_key": "choline_related",
      "unit": "mg",
      "field_path": "/nutrients/choline_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/choline_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "choline_free_mg",
      "group_key": "choline_related",
      "unit": "mg",
      "field_path": "/nutrients/choline_free_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/choline_free_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "choline_from_glycerophosphocholine_mg",
      "group_key": "choline_related",
      "unit": "mg",
      "field_path": "/nutrients/choline_from_glycerophosphocholine_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/choline_from_glycerophosphocholine_mg",
      "notes": "Mass of the choline moiety supplied by this compound, not the whole compound mass."
    },
    {
      "key": "choline_from_phosphocholine_mg",
      "group_key": "choline_related",
      "unit": "mg",
      "field_path": "/nutrients/choline_from_phosphocholine_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/choline_from_phosphocholine_mg",
      "notes": "Mass of the choline moiety supplied by this compound, not the whole compound mass."
    },
    {
      "key": "choline_from_phosphatidylcholine_mg",
      "group_key": "choline_related",
      "unit": "mg",
      "field_path": "/nutrients/choline_from_phosphatidylcholine_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/choline_from_phosphatidylcholine_mg",
      "notes": "Mass of the choline moiety supplied by this compound, not the whole compound mass."
    },
    {
      "key": "choline_from_sphingomyelin_mg",
      "group_key": "choline_related",
      "unit": "mg",
      "field_path": "/nutrients/choline_from_sphingomyelin_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/choline_from_sphingomyelin_mg",
      "notes": "Mass of the choline moiety supplied by this compound, not the whole compound mass."
    },
    {
      "key": "betaine_mg",
      "group_key": "choline_related",
      "unit": "mg",
      "field_path": "/nutrients/betaine_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/betaine_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "caffeine_mg",
      "group_key": "other_food_components",
      "unit": "mg",
      "field_path": "/nutrients/caffeine_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/caffeine_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "theobromine_mg",
      "group_key": "other_food_components",
      "unit": "mg",
      "field_path": "/nutrients/theobromine_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/theobromine_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "phytosterols_mg",
      "group_key": "other_food_components",
      "unit": "mg",
      "field_path": "/nutrients/phytosterols_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/phytosterols_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "beta_sitosterol_mg",
      "group_key": "other_food_components",
      "unit": "mg",
      "field_path": "/nutrients/beta_sitosterol_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/beta_sitosterol_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "campesterol_mg",
      "group_key": "other_food_components",
      "unit": "mg",
      "field_path": "/nutrients/campesterol_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/campesterol_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "stigmasterol_mg",
      "group_key": "other_food_components",
      "unit": "mg",
      "field_path": "/nutrients/stigmasterol_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/stigmasterol_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "total_isoflavones_mg",
      "group_key": "other_food_components",
      "unit": "mg",
      "field_path": "/nutrients/total_isoflavones_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/total_isoflavones_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "daidzein_mg",
      "group_key": "other_food_components",
      "unit": "mg",
      "field_path": "/nutrients/daidzein_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/daidzein_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "genistein_mg",
      "group_key": "other_food_components",
      "unit": "mg",
      "field_path": "/nutrients/genistein_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/genistein_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "glycitein_mg",
      "group_key": "other_food_components",
      "unit": "mg",
      "field_path": "/nutrients/glycitein_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/glycitein_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "total_oxalate_mg",
      "group_key": "other_food_components",
      "unit": "mg",
      "field_path": "/nutrients/total_oxalate_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/total_oxalate_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "soluble_oxalate_mg",
      "group_key": "other_food_components",
      "unit": "mg",
      "field_path": "/nutrients/soluble_oxalate_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/soluble_oxalate_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "phytate_mg",
      "group_key": "other_food_components",
      "unit": "mg",
      "field_path": "/nutrients/phytate_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/phytate_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    },
    {
      "key": "total_purines_mg",
      "group_key": "other_food_components",
      "unit": "mg",
      "field_path": "/nutrients/total_purines_mg",
      "value_schema": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0
      },
      "quantity_basis": "amount_for_consumed_intake_or_explicit_day",
      "qualifier_path": "/nutrient_qualifiers/total_purines_mg",
      "notes": "Preserve the exact component/form and reporting basis; see the v5 specification."
    }
  ],
  "lab_panels": [
    {
      "panel_key": "cbc",
      "analyte_keys": [
        "hemoglobin",
        "hematocrit",
        "rbc_count",
        "wbc_count",
        "platelet_count",
        "mcv",
        "mch",
        "mchc",
        "rdw_cv",
        "rdw_sd",
        "neutrophils_percent",
        "neutrophils_absolute",
        "lymphocytes_percent",
        "lymphocytes_absolute",
        "monocytes_percent",
        "monocytes_absolute",
        "eosinophils_percent",
        "eosinophils_absolute",
        "basophils_percent",
        "basophils_absolute",
        "immature_granulocytes_percent",
        "immature_granulocytes_absolute",
        "band_neutrophils_percent",
        "band_neutrophils_absolute",
        "nucleated_rbc_per_100_wbc",
        "nucleated_rbc_absolute",
        "mpv",
        "pdw",
        "plateletcrit",
        "platelet_large_cell_ratio",
        "rbc_morphology",
        "wbc_morphology",
        "platelet_morphology",
        "peripheral_smear_findings"
      ],
      "analyte_count": 34
    },
    {
      "panel_key": "reticulocyte_hemoglobinopathy",
      "analyte_keys": [
        "reticulocytes_percent",
        "reticulocytes_absolute",
        "immature_reticulocyte_fraction",
        "reticulocyte_hemoglobin",
        "hemoglobin_a_percent",
        "hemoglobin_a2_percent",
        "hemoglobin_f_percent",
        "hemoglobin_s_percent",
        "hemoglobin_c_percent",
        "hemoglobin_e_percent",
        "hemoglobin_variant_identification",
        "haptoglobin",
        "g6pd_activity",
        "direct_antiglobulin_test"
      ],
      "analyte_count": 14
    },
    {
      "panel_key": "glycemic",
      "analyte_keys": [
        "blood_glucose",
        "hba1c",
        "estimated_average_glucose",
        "insulin",
        "c_peptide",
        "fructosamine",
        "glycated_albumin",
        "beta_hydroxybutyrate",
        "blood_ketones",
        "homa_ir_reported"
      ],
      "analyte_count": 10
    },
    {
      "panel_key": "lipid",
      "analyte_keys": [
        "total_cholesterol",
        "ldl_cholesterol",
        "hdl_cholesterol",
        "triglycerides",
        "non_hdl_cholesterol",
        "apolipoprotein_b",
        "apolipoprotein_a1",
        "lipoprotein_a_mass",
        "lipoprotein_a_molar",
        "vldl_cholesterol",
        "remnant_cholesterol",
        "total_cholesterol_hdl_ratio",
        "ldl_hdl_ratio",
        "triglyceride_hdl_ratio",
        "apob_apoa1_ratio",
        "ldl_particle_number",
        "small_ldl_particle_number",
        "ldl_particle_size",
        "hdl_particle_number"
      ],
      "analyte_count": 19
    },
    {
      "panel_key": "renal_electrolytes",
      "analyte_keys": [
        "creatinine",
        "egfr",
        "urea",
        "bun",
        "uric_acid",
        "sodium",
        "potassium",
        "chloride",
        "bicarbonate",
        "carbon_dioxide_total",
        "calcium_total",
        "calcium_ionized",
        "phosphate",
        "magnesium",
        "urine_albumin_creatinine_ratio",
        "cystatin_c",
        "egfr_cystatin_c",
        "egfr_creatinine_cystatin_c",
        "creatinine_clearance",
        "bun_creatinine_ratio",
        "anion_gap",
        "measured_osmolality",
        "calculated_osmolality"
      ],
      "analyte_count": 23
    },
    {
      "panel_key": "urine_quantitative",
      "analyte_keys": [
        "urine_albumin",
        "urine_creatinine",
        "urine_albumin_creatinine_ratio",
        "urine_protein_concentration",
        "urine_protein_creatinine_ratio",
        "urine_albumin_excretion_rate",
        "urine_protein_24h",
        "urine_creatinine_24h",
        "urine_sodium_concentration",
        "urine_sodium_24h",
        "urine_potassium_concentration",
        "urine_potassium_24h",
        "urine_calcium_concentration",
        "urine_calcium_24h",
        "urine_phosphate_concentration",
        "urine_phosphate_24h",
        "urine_uric_acid_concentration",
        "urine_uric_acid_24h",
        "urine_urea_nitrogen_24h",
        "urine_cortisol_free_24h",
        "urine_osmolality",
        "urine_collection_volume",
        "urine_collection_duration"
      ],
      "analyte_count": 23
    },
    {
      "panel_key": "liver_protein",
      "analyte_keys": [
        "alt",
        "ast",
        "alp",
        "ggt",
        "bilirubin_total",
        "bilirubin_direct",
        "bilirubin_indirect",
        "albumin",
        "globulin",
        "total_protein",
        "albumin_globulin_ratio",
        "ast_alt_ratio",
        "ldh",
        "ammonia",
        "bile_acids_total",
        "prealbumin",
        "fib4_reported"
      ],
      "analyte_count": 17
    },
    {
      "panel_key": "thyroid",
      "analyte_keys": [
        "tsh",
        "free_t4",
        "total_t4",
        "free_t3",
        "total_t3",
        "tpo_antibodies",
        "thyroglobulin_antibodies",
        "tsh_receptor_antibodies",
        "thyroid_stimulating_immunoglobulin",
        "thyroglobulin",
        "reverse_t3"
      ],
      "analyte_count": 11
    },
    {
      "panel_key": "iron_studies",
      "analyte_keys": [
        "ferritin",
        "iron",
        "transferrin",
        "tibc",
        "uibc",
        "transferrin_saturation",
        "soluble_transferrin_receptor",
        "reticulocyte_hemoglobin"
      ],
      "analyte_count": 8
    },
    {
      "panel_key": "vitamins_minerals",
      "analyte_keys": [
        "vitamin_d_25_oh_total",
        "vitamin_d_25_oh_d2",
        "vitamin_d_25_oh_d3",
        "vitamin_d_1_25_dihydroxy",
        "vitamin_b12",
        "active_b12_holotranscobalamin",
        "folate_serum",
        "folate_rbc",
        "methylmalonic_acid",
        "homocysteine",
        "vitamin_a_retinol",
        "beta_carotene",
        "vitamin_e_alpha_tocopherol",
        "vitamin_e_gamma_tocopherol",
        "vitamin_c",
        "vitamin_b1_thiamine",
        "vitamin_b1_thiamine_diphosphate",
        "vitamin_b2_riboflavin",
        "vitamin_b6_pyridoxal_phosphate",
        "vitamin_k1",
        "iron",
        "calcium_total",
        "calcium_ionized",
        "magnesium",
        "magnesium_rbc",
        "phosphate",
        "zinc",
        "copper",
        "ceruloplasmin",
        "selenium",
        "iodine",
        "chromium",
        "molybdenum",
        "manganese"
      ],
      "analyte_count": 34
    },
    {
      "panel_key": "inflammation",
      "analyte_keys": [
        "crp",
        "hs_crp",
        "esr",
        "procalcitonin",
        "ferritin"
      ],
      "analyte_count": 5
    },
    {
      "panel_key": "urinalysis",
      "analyte_keys": [
        "urine_ph",
        "urine_specific_gravity",
        "urine_protein",
        "urine_glucose",
        "urine_ketones",
        "urine_blood",
        "urine_leukocyte_esterase",
        "urine_nitrite",
        "urine_bilirubin",
        "urine_urobilinogen",
        "urine_rbc",
        "urine_wbc",
        "urine_albumin_creatinine_ratio",
        "urine_color",
        "urine_clarity",
        "urine_squamous_epithelial_cells",
        "urine_transitional_epithelial_cells",
        "urine_renal_epithelial_cells",
        "urine_hyaline_casts",
        "urine_granular_casts",
        "urine_rbc_casts",
        "urine_wbc_casts",
        "urine_waxy_casts",
        "urine_crystals",
        "urine_bacteria",
        "urine_yeast",
        "urine_mucus"
      ],
      "analyte_count": 27
    },
    {
      "panel_key": "coagulation",
      "analyte_keys": [
        "prothrombin_time",
        "inr",
        "aptt",
        "aptt_ratio",
        "thrombin_time",
        "fibrinogen_activity",
        "fibrinogen_antigen",
        "d_dimer_feu",
        "d_dimer_ddu",
        "fibrin_degradation_products",
        "anti_factor_xa",
        "antithrombin_activity",
        "protein_c_activity",
        "protein_s_activity",
        "lupus_anticoagulant_screen",
        "drvvt_screen_ratio",
        "drvvt_confirm_ratio"
      ],
      "analyte_count": 17
    },
    {
      "panel_key": "cardiac_muscle",
      "analyte_keys": [
        "troponin_i",
        "troponin_t",
        "hs_troponin_i",
        "hs_troponin_t",
        "bnp",
        "nt_probnp",
        "creatine_kinase",
        "ck_mb_mass",
        "ck_mb_activity",
        "myoglobin",
        "ldh"
      ],
      "analyte_count": 11
    },
    {
      "panel_key": "pancreatic_digestive",
      "analyte_keys": [
        "amylase",
        "pancreatic_amylase",
        "lipase",
        "gastrin"
      ],
      "analyte_count": 4
    },
    {
      "panel_key": "bone_metabolism",
      "analyte_keys": [
        "parathyroid_hormone_intact",
        "parathyroid_hormone_whole",
        "calcium_total",
        "calcium_ionized",
        "phosphate",
        "magnesium",
        "alp",
        "bone_specific_alp",
        "osteocalcin",
        "procollagen_type_1_n_terminal_propeptide",
        "beta_ctx",
        "vitamin_d_25_oh_total",
        "vitamin_d_1_25_dihydroxy"
      ],
      "analyte_count": 13
    },
    {
      "panel_key": "pituitary_adrenal",
      "analyte_keys": [
        "cortisol",
        "acth",
        "dheas",
        "aldosterone",
        "renin_activity",
        "renin_concentration",
        "aldosterone_renin_ratio",
        "growth_hormone",
        "igf_1",
        "metanephrine_free",
        "normetanephrine_free"
      ],
      "analyte_count": 11
    },
    {
      "panel_key": "reproductive_hormones",
      "analyte_keys": [
        "fsh",
        "lh",
        "estradiol",
        "progesterone",
        "testosterone_total",
        "testosterone_free",
        "testosterone_bioavailable",
        "shbg",
        "prolactin",
        "amh",
        "dheas",
        "androstenedione",
        "seventeen_hydroxyprogesterone",
        "hcg_quantitative",
        "hcg_qualitative",
        "inhibin_b"
      ],
      "analyte_count": 16
    },
    {
      "panel_key": "reproductive_semen",
      "analyte_keys": [
        "semen_volume",
        "semen_ph",
        "semen_liquefaction_time",
        "semen_viscosity",
        "sperm_concentration",
        "sperm_total_count",
        "sperm_total_motility",
        "sperm_progressive_motility",
        "sperm_nonprogressive_motility",
        "sperm_immotile_percent",
        "sperm_vitality",
        "sperm_normal_morphology",
        "semen_leukocytes",
        "sperm_agglutination",
        "sperm_dna_fragmentation_index"
      ],
      "analyte_count": 15
    },
    {
      "panel_key": "immunology_autoimmune",
      "analyte_keys": [
        "ana_screen",
        "ana_titer",
        "ana_pattern",
        "anti_dsdna",
        "anti_smith",
        "anti_rnp",
        "anti_ssa_ro",
        "anti_ssb_la",
        "anti_scl70",
        "anti_centromere",
        "anti_jo1",
        "rheumatoid_factor",
        "anti_ccp",
        "c3_complement",
        "c4_complement",
        "ch50",
        "immunoglobulin_g",
        "immunoglobulin_a",
        "immunoglobulin_m",
        "immunoglobulin_e_total",
        "immunoglobulin_g1",
        "immunoglobulin_g2",
        "immunoglobulin_g3",
        "immunoglobulin_g4",
        "allergen_specific_ige",
        "anca_screen",
        "anca_pattern",
        "anca_titer",
        "anti_mpo",
        "anti_pr3",
        "anti_cardiolipin_igg",
        "anti_cardiolipin_igm",
        "anti_beta2_glycoprotein_igg",
        "anti_beta2_glycoprotein_igm"
      ],
      "analyte_count": 34
    },
    {
      "panel_key": "celiac",
      "analyte_keys": [
        "tissue_transglutaminase_iga",
        "tissue_transglutaminase_igg",
        "endomysial_antibody_iga",
        "deamidated_gliadin_peptide_iga",
        "deamidated_gliadin_peptide_igg",
        "immunoglobulin_a"
      ],
      "analyte_count": 6
    },
    {
      "panel_key": "infectious_serology",
      "analyte_keys": [
        "hepatitis_b_surface_antigen",
        "hepatitis_b_surface_antibody",
        "hepatitis_b_core_antibody_total",
        "hepatitis_b_core_antibody_igm",
        "hepatitis_b_e_antigen",
        "hepatitis_b_e_antibody",
        "hepatitis_c_antibody",
        "hepatitis_a_igm",
        "hepatitis_a_antibody_total",
        "hiv_1_2_antigen_antibody",
        "hiv_1_antibody",
        "hiv_2_antibody",
        "syphilis_treponemal_antibody",
        "rpr_qualitative",
        "rpr_titer",
        "dengue_ns1_antigen",
        "dengue_igm",
        "dengue_igg"
      ],
      "analyte_count": 18
    },
    {
      "panel_key": "microbiology_molecular",
      "analyte_keys": [
        "hepatitis_b_dna",
        "hepatitis_c_rna",
        "hiv_1_rna",
        "respiratory_pathogen_pcr",
        "gastrointestinal_pathogen_pcr",
        "pathogen_nucleic_acid",
        "organism_culture_identification",
        "antimicrobial_susceptibility",
        "malaria_parasite_test"
      ],
      "analyte_count": 9
    },
    {
      "panel_key": "stool_digestive",
      "analyte_keys": [
        "stool_occult_blood_guaiac",
        "stool_hemoglobin_fit",
        "fecal_calprotectin",
        "fecal_lactoferrin",
        "fecal_pancreatic_elastase",
        "fecal_fat_qualitative",
        "fecal_fat_24h",
        "stool_collection_mass",
        "stool_collection_duration",
        "stool_ph",
        "stool_reducing_substances",
        "stool_rbc",
        "stool_wbc",
        "stool_ova_parasites",
        "stool_helicobacter_pylori_antigen",
        "stool_clostridioides_difficile_toxin"
      ],
      "analyte_count": 16
    },
    {
      "panel_key": "tumor_markers",
      "analyte_keys": [
        "psa_total",
        "psa_free",
        "psa_free_total_ratio",
        "alpha_fetoprotein",
        "cea",
        "ca_125",
        "ca_19_9",
        "ca_15_3",
        "calcitonin",
        "beta2_microglobulin"
      ],
      "analyte_count": 10
    },
    {
      "panel_key": "therapeutic_drug_monitoring",
      "analyte_keys": [
        "lithium",
        "valproic_acid_total",
        "valproic_acid_free",
        "phenytoin_total",
        "phenytoin_free",
        "carbamazepine",
        "digoxin",
        "tacrolimus",
        "cyclosporine",
        "sirolimus",
        "vancomycin",
        "gentamicin"
      ],
      "analyte_count": 12
    },
    {
      "panel_key": "toxicology_metals",
      "analyte_keys": [
        "lead",
        "mercury_total",
        "arsenic_total",
        "arsenic_inorganic",
        "cadmium",
        "aluminum",
        "carboxyhemoglobin",
        "methemoglobin",
        "ethanol",
        "cotinine"
      ],
      "analyte_count": 10
    },
    {
      "panel_key": "blood_group_immunohematology",
      "analyte_keys": [
        "blood_group_abo",
        "rhd_type",
        "red_cell_antibody_screen",
        "red_cell_antibody_identification",
        "direct_antiglobulin_test"
      ],
      "analyte_count": 5
    },
    {
      "panel_key": "specimen_quality",
      "analyte_keys": [
        "hemolysis_index",
        "lipemia_index",
        "icterus_index"
      ],
      "analyte_count": 3
    },
    {
      "panel_key": "blood_gas",
      "analyte_keys": [
        "blood_gas_ph",
        "partial_pressure_oxygen",
        "partial_pressure_carbon_dioxide",
        "bicarbonate",
        "blood_gas_bicarbonate_standard",
        "base_excess",
        "oxygen_saturation_blood_gas",
        "oxygen_content",
        "lactate",
        "ionized_calcium_blood_gas",
        "carboxyhemoglobin",
        "methemoglobin"
      ],
      "analyte_count": 12
    }
  ],
  "lab_analytes": [
    {
      "analyte_key": "acth",
      "panel_keys": [
        "pituitary_adrenal"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "active_b12_holotranscobalamin",
      "panel_keys": [
        "vitamins_minerals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "albumin",
      "panel_keys": [
        "liver_protein"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "albumin_globulin_ratio",
      "panel_keys": [
        "liver_protein"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "aldosterone",
      "panel_keys": [
        "pituitary_adrenal"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "aldosterone_renin_ratio",
      "panel_keys": [
        "pituitary_adrenal"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "allergen_specific_ige",
      "panel_keys": [
        "immunology_autoimmune"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "alp",
      "panel_keys": [
        "liver_protein",
        "bone_metabolism"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "alpha_fetoprotein",
      "panel_keys": [
        "tumor_markers"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "alt",
      "panel_keys": [
        "liver_protein"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "aluminum",
      "panel_keys": [
        "toxicology_metals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "amh",
      "panel_keys": [
        "reproductive_hormones"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "ammonia",
      "panel_keys": [
        "liver_protein"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "amylase",
      "panel_keys": [
        "pancreatic_digestive"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "ana_pattern",
      "panel_keys": [
        "immunology_autoimmune"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "ana_screen",
      "panel_keys": [
        "immunology_autoimmune"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "ana_titer",
      "panel_keys": [
        "immunology_autoimmune"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "anca_pattern",
      "panel_keys": [
        "immunology_autoimmune"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "anca_screen",
      "panel_keys": [
        "immunology_autoimmune"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "anca_titer",
      "panel_keys": [
        "immunology_autoimmune"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "androstenedione",
      "panel_keys": [
        "reproductive_hormones"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "anion_gap",
      "panel_keys": [
        "renal_electrolytes"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "anti_beta2_glycoprotein_igg",
      "panel_keys": [
        "immunology_autoimmune"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "anti_beta2_glycoprotein_igm",
      "panel_keys": [
        "immunology_autoimmune"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "anti_cardiolipin_igg",
      "panel_keys": [
        "immunology_autoimmune"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "anti_cardiolipin_igm",
      "panel_keys": [
        "immunology_autoimmune"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "anti_ccp",
      "panel_keys": [
        "immunology_autoimmune"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "anti_centromere",
      "panel_keys": [
        "immunology_autoimmune"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "anti_dsdna",
      "panel_keys": [
        "immunology_autoimmune"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "anti_factor_xa",
      "panel_keys": [
        "coagulation"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "anti_jo1",
      "panel_keys": [
        "immunology_autoimmune"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "anti_mpo",
      "panel_keys": [
        "immunology_autoimmune"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "anti_pr3",
      "panel_keys": [
        "immunology_autoimmune"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "anti_rnp",
      "panel_keys": [
        "immunology_autoimmune"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "anti_scl70",
      "panel_keys": [
        "immunology_autoimmune"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "anti_smith",
      "panel_keys": [
        "immunology_autoimmune"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "anti_ssa_ro",
      "panel_keys": [
        "immunology_autoimmune"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "anti_ssb_la",
      "panel_keys": [
        "immunology_autoimmune"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "antimicrobial_susceptibility",
      "panel_keys": [
        "microbiology_molecular"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "antithrombin_activity",
      "panel_keys": [
        "coagulation"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "apob_apoa1_ratio",
      "panel_keys": [
        "lipid"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "apolipoprotein_a1",
      "panel_keys": [
        "lipid"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "apolipoprotein_b",
      "panel_keys": [
        "lipid"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "aptt",
      "panel_keys": [
        "coagulation"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "aptt_ratio",
      "panel_keys": [
        "coagulation"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "arsenic_inorganic",
      "panel_keys": [
        "toxicology_metals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "arsenic_total",
      "panel_keys": [
        "toxicology_metals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "ast",
      "panel_keys": [
        "liver_protein"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "ast_alt_ratio",
      "panel_keys": [
        "liver_protein"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "band_neutrophils_absolute",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "band_neutrophils_percent",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "base_excess",
      "panel_keys": [
        "blood_gas"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "basophils_absolute",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "basophils_percent",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "beta2_microglobulin",
      "panel_keys": [
        "tumor_markers"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "beta_carotene",
      "panel_keys": [
        "vitamins_minerals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "beta_ctx",
      "panel_keys": [
        "bone_metabolism"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "beta_hydroxybutyrate",
      "panel_keys": [
        "glycemic"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "bicarbonate",
      "panel_keys": [
        "renal_electrolytes",
        "blood_gas"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "bile_acids_total",
      "panel_keys": [
        "liver_protein"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "bilirubin_direct",
      "panel_keys": [
        "liver_protein"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "bilirubin_indirect",
      "panel_keys": [
        "liver_protein"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "bilirubin_total",
      "panel_keys": [
        "liver_protein"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "blood_gas_bicarbonate_standard",
      "panel_keys": [
        "blood_gas"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "blood_gas_ph",
      "panel_keys": [
        "blood_gas"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "blood_glucose",
      "panel_keys": [
        "glycemic"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "blood_group_abo",
      "panel_keys": [
        "blood_group_immunohematology"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "blood_ketones",
      "panel_keys": [
        "glycemic"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "bnp",
      "panel_keys": [
        "cardiac_muscle"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "bone_specific_alp",
      "panel_keys": [
        "bone_metabolism"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "bun",
      "panel_keys": [
        "renal_electrolytes"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "bun_creatinine_ratio",
      "panel_keys": [
        "renal_electrolytes"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "c3_complement",
      "panel_keys": [
        "immunology_autoimmune"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "c4_complement",
      "panel_keys": [
        "immunology_autoimmune"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "c_peptide",
      "panel_keys": [
        "glycemic"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "ca_125",
      "panel_keys": [
        "tumor_markers"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "ca_15_3",
      "panel_keys": [
        "tumor_markers"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "ca_19_9",
      "panel_keys": [
        "tumor_markers"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "cadmium",
      "panel_keys": [
        "toxicology_metals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "calcitonin",
      "panel_keys": [
        "tumor_markers"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "calcium_ionized",
      "panel_keys": [
        "renal_electrolytes",
        "vitamins_minerals",
        "bone_metabolism"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "calcium_total",
      "panel_keys": [
        "renal_electrolytes",
        "vitamins_minerals",
        "bone_metabolism"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "calculated_osmolality",
      "panel_keys": [
        "renal_electrolytes"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "carbamazepine",
      "panel_keys": [
        "therapeutic_drug_monitoring"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "carbon_dioxide_total",
      "panel_keys": [
        "renal_electrolytes"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "carboxyhemoglobin",
      "panel_keys": [
        "toxicology_metals",
        "blood_gas"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "cea",
      "panel_keys": [
        "tumor_markers"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "ceruloplasmin",
      "panel_keys": [
        "vitamins_minerals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "ch50",
      "panel_keys": [
        "immunology_autoimmune"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "chloride",
      "panel_keys": [
        "renal_electrolytes"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "chromium",
      "panel_keys": [
        "vitamins_minerals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "ck_mb_activity",
      "panel_keys": [
        "cardiac_muscle"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "ck_mb_mass",
      "panel_keys": [
        "cardiac_muscle"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "copper",
      "panel_keys": [
        "vitamins_minerals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "cortisol",
      "panel_keys": [
        "pituitary_adrenal"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "cotinine",
      "panel_keys": [
        "toxicology_metals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "creatine_kinase",
      "panel_keys": [
        "cardiac_muscle"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "creatinine",
      "panel_keys": [
        "renal_electrolytes"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "creatinine_clearance",
      "panel_keys": [
        "renal_electrolytes"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "crp",
      "panel_keys": [
        "inflammation"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "cyclosporine",
      "panel_keys": [
        "therapeutic_drug_monitoring"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "cystatin_c",
      "panel_keys": [
        "renal_electrolytes"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "d_dimer_ddu",
      "panel_keys": [
        "coagulation"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "d_dimer_feu",
      "panel_keys": [
        "coagulation"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "deamidated_gliadin_peptide_iga",
      "panel_keys": [
        "celiac"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "deamidated_gliadin_peptide_igg",
      "panel_keys": [
        "celiac"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "dengue_igg",
      "panel_keys": [
        "infectious_serology"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "dengue_igm",
      "panel_keys": [
        "infectious_serology"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "dengue_ns1_antigen",
      "panel_keys": [
        "infectious_serology"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "dheas",
      "panel_keys": [
        "pituitary_adrenal",
        "reproductive_hormones"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "digoxin",
      "panel_keys": [
        "therapeutic_drug_monitoring"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "direct_antiglobulin_test",
      "panel_keys": [
        "reticulocyte_hemoglobinopathy",
        "blood_group_immunohematology"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "drvvt_confirm_ratio",
      "panel_keys": [
        "coagulation"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "drvvt_screen_ratio",
      "panel_keys": [
        "coagulation"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "egfr",
      "panel_keys": [
        "renal_electrolytes"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "egfr_creatinine_cystatin_c",
      "panel_keys": [
        "renal_electrolytes"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "egfr_cystatin_c",
      "panel_keys": [
        "renal_electrolytes"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "endomysial_antibody_iga",
      "panel_keys": [
        "celiac"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "eosinophils_absolute",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "eosinophils_percent",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "esr",
      "panel_keys": [
        "inflammation"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "estimated_average_glucose",
      "panel_keys": [
        "glycemic"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "estradiol",
      "panel_keys": [
        "reproductive_hormones"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "ethanol",
      "panel_keys": [
        "toxicology_metals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "fecal_calprotectin",
      "panel_keys": [
        "stool_digestive"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "fecal_fat_24h",
      "panel_keys": [
        "stool_digestive"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "fecal_fat_qualitative",
      "panel_keys": [
        "stool_digestive"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "fecal_lactoferrin",
      "panel_keys": [
        "stool_digestive"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "fecal_pancreatic_elastase",
      "panel_keys": [
        "stool_digestive"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "ferritin",
      "panel_keys": [
        "iron_studies",
        "inflammation"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "fib4_reported",
      "panel_keys": [
        "liver_protein"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "fibrin_degradation_products",
      "panel_keys": [
        "coagulation"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "fibrinogen_activity",
      "panel_keys": [
        "coagulation"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "fibrinogen_antigen",
      "panel_keys": [
        "coagulation"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "folate_rbc",
      "panel_keys": [
        "vitamins_minerals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "folate_serum",
      "panel_keys": [
        "vitamins_minerals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "free_t3",
      "panel_keys": [
        "thyroid"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "free_t4",
      "panel_keys": [
        "thyroid"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "fructosamine",
      "panel_keys": [
        "glycemic"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "fsh",
      "panel_keys": [
        "reproductive_hormones"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "g6pd_activity",
      "panel_keys": [
        "reticulocyte_hemoglobinopathy"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "gastrin",
      "panel_keys": [
        "pancreatic_digestive"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "gastrointestinal_pathogen_pcr",
      "panel_keys": [
        "microbiology_molecular"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "gentamicin",
      "panel_keys": [
        "therapeutic_drug_monitoring"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "ggt",
      "panel_keys": [
        "liver_protein"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "globulin",
      "panel_keys": [
        "liver_protein"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "glycated_albumin",
      "panel_keys": [
        "glycemic"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "growth_hormone",
      "panel_keys": [
        "pituitary_adrenal"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "haptoglobin",
      "panel_keys": [
        "reticulocyte_hemoglobinopathy"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "hba1c",
      "panel_keys": [
        "glycemic"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "hcg_qualitative",
      "panel_keys": [
        "reproductive_hormones"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "hcg_quantitative",
      "panel_keys": [
        "reproductive_hormones"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "hdl_cholesterol",
      "panel_keys": [
        "lipid"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "hdl_particle_number",
      "panel_keys": [
        "lipid"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "hematocrit",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "hemoglobin",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "hemoglobin_a2_percent",
      "panel_keys": [
        "reticulocyte_hemoglobinopathy"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "hemoglobin_a_percent",
      "panel_keys": [
        "reticulocyte_hemoglobinopathy"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "hemoglobin_c_percent",
      "panel_keys": [
        "reticulocyte_hemoglobinopathy"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "hemoglobin_e_percent",
      "panel_keys": [
        "reticulocyte_hemoglobinopathy"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "hemoglobin_f_percent",
      "panel_keys": [
        "reticulocyte_hemoglobinopathy"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "hemoglobin_s_percent",
      "panel_keys": [
        "reticulocyte_hemoglobinopathy"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "hemoglobin_variant_identification",
      "panel_keys": [
        "reticulocyte_hemoglobinopathy"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "hemolysis_index",
      "panel_keys": [
        "specimen_quality"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "hepatitis_a_antibody_total",
      "panel_keys": [
        "infectious_serology"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "hepatitis_a_igm",
      "panel_keys": [
        "infectious_serology"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "hepatitis_b_core_antibody_igm",
      "panel_keys": [
        "infectious_serology"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "hepatitis_b_core_antibody_total",
      "panel_keys": [
        "infectious_serology"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "hepatitis_b_dna",
      "panel_keys": [
        "microbiology_molecular"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "hepatitis_b_e_antibody",
      "panel_keys": [
        "infectious_serology"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "hepatitis_b_e_antigen",
      "panel_keys": [
        "infectious_serology"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "hepatitis_b_surface_antibody",
      "panel_keys": [
        "infectious_serology"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "hepatitis_b_surface_antigen",
      "panel_keys": [
        "infectious_serology"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "hepatitis_c_antibody",
      "panel_keys": [
        "infectious_serology"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "hepatitis_c_rna",
      "panel_keys": [
        "microbiology_molecular"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "hiv_1_2_antigen_antibody",
      "panel_keys": [
        "infectious_serology"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "hiv_1_antibody",
      "panel_keys": [
        "infectious_serology"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "hiv_1_rna",
      "panel_keys": [
        "microbiology_molecular"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "hiv_2_antibody",
      "panel_keys": [
        "infectious_serology"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "homa_ir_reported",
      "panel_keys": [
        "glycemic"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "homocysteine",
      "panel_keys": [
        "vitamins_minerals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "hs_crp",
      "panel_keys": [
        "inflammation"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "hs_troponin_i",
      "panel_keys": [
        "cardiac_muscle"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "hs_troponin_t",
      "panel_keys": [
        "cardiac_muscle"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "icterus_index",
      "panel_keys": [
        "specimen_quality"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "igf_1",
      "panel_keys": [
        "pituitary_adrenal"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "immature_granulocytes_absolute",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "immature_granulocytes_percent",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "immature_reticulocyte_fraction",
      "panel_keys": [
        "reticulocyte_hemoglobinopathy"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "immunoglobulin_a",
      "panel_keys": [
        "immunology_autoimmune",
        "celiac"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "immunoglobulin_e_total",
      "panel_keys": [
        "immunology_autoimmune"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "immunoglobulin_g",
      "panel_keys": [
        "immunology_autoimmune"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "immunoglobulin_g1",
      "panel_keys": [
        "immunology_autoimmune"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "immunoglobulin_g2",
      "panel_keys": [
        "immunology_autoimmune"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "immunoglobulin_g3",
      "panel_keys": [
        "immunology_autoimmune"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "immunoglobulin_g4",
      "panel_keys": [
        "immunology_autoimmune"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "immunoglobulin_m",
      "panel_keys": [
        "immunology_autoimmune"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "inhibin_b",
      "panel_keys": [
        "reproductive_hormones"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "inr",
      "panel_keys": [
        "coagulation"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "insulin",
      "panel_keys": [
        "glycemic"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "iodine",
      "panel_keys": [
        "vitamins_minerals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "ionized_calcium_blood_gas",
      "panel_keys": [
        "blood_gas"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "iron",
      "panel_keys": [
        "iron_studies",
        "vitamins_minerals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "lactate",
      "panel_keys": [
        "blood_gas"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "ldh",
      "panel_keys": [
        "liver_protein",
        "cardiac_muscle"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "ldl_cholesterol",
      "panel_keys": [
        "lipid"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "ldl_hdl_ratio",
      "panel_keys": [
        "lipid"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "ldl_particle_number",
      "panel_keys": [
        "lipid"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "ldl_particle_size",
      "panel_keys": [
        "lipid"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "lead",
      "panel_keys": [
        "toxicology_metals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "lh",
      "panel_keys": [
        "reproductive_hormones"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "lipase",
      "panel_keys": [
        "pancreatic_digestive"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "lipemia_index",
      "panel_keys": [
        "specimen_quality"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "lipoprotein_a_mass",
      "panel_keys": [
        "lipid"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "lipoprotein_a_molar",
      "panel_keys": [
        "lipid"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "lithium",
      "panel_keys": [
        "therapeutic_drug_monitoring"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "lupus_anticoagulant_screen",
      "panel_keys": [
        "coagulation"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "lymphocytes_absolute",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "lymphocytes_percent",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "magnesium",
      "panel_keys": [
        "renal_electrolytes",
        "vitamins_minerals",
        "bone_metabolism"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "magnesium_rbc",
      "panel_keys": [
        "vitamins_minerals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "malaria_parasite_test",
      "panel_keys": [
        "microbiology_molecular"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "manganese",
      "panel_keys": [
        "vitamins_minerals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "mch",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "mchc",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "mcv",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "measured_osmolality",
      "panel_keys": [
        "renal_electrolytes"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "mercury_total",
      "panel_keys": [
        "toxicology_metals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "metanephrine_free",
      "panel_keys": [
        "pituitary_adrenal"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "methemoglobin",
      "panel_keys": [
        "toxicology_metals",
        "blood_gas"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "methylmalonic_acid",
      "panel_keys": [
        "vitamins_minerals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "molybdenum",
      "panel_keys": [
        "vitamins_minerals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "monocytes_absolute",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "monocytes_percent",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "mpv",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "myoglobin",
      "panel_keys": [
        "cardiac_muscle"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "neutrophils_absolute",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "neutrophils_percent",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "non_hdl_cholesterol",
      "panel_keys": [
        "lipid"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "normetanephrine_free",
      "panel_keys": [
        "pituitary_adrenal"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "nt_probnp",
      "panel_keys": [
        "cardiac_muscle"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "nucleated_rbc_absolute",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "nucleated_rbc_per_100_wbc",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "organism_culture_identification",
      "panel_keys": [
        "microbiology_molecular"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "osteocalcin",
      "panel_keys": [
        "bone_metabolism"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "oxygen_content",
      "panel_keys": [
        "blood_gas"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "oxygen_saturation_blood_gas",
      "panel_keys": [
        "blood_gas"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "pancreatic_amylase",
      "panel_keys": [
        "pancreatic_digestive"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "parathyroid_hormone_intact",
      "panel_keys": [
        "bone_metabolism"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "parathyroid_hormone_whole",
      "panel_keys": [
        "bone_metabolism"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "partial_pressure_carbon_dioxide",
      "panel_keys": [
        "blood_gas"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "partial_pressure_oxygen",
      "panel_keys": [
        "blood_gas"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "pathogen_nucleic_acid",
      "panel_keys": [
        "microbiology_molecular"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "pdw",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "peripheral_smear_findings",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "phenytoin_free",
      "panel_keys": [
        "therapeutic_drug_monitoring"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "phenytoin_total",
      "panel_keys": [
        "therapeutic_drug_monitoring"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "phosphate",
      "panel_keys": [
        "renal_electrolytes",
        "vitamins_minerals",
        "bone_metabolism"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "platelet_count",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "platelet_large_cell_ratio",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "platelet_morphology",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "plateletcrit",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "potassium",
      "panel_keys": [
        "renal_electrolytes"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "prealbumin",
      "panel_keys": [
        "liver_protein"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "procalcitonin",
      "panel_keys": [
        "inflammation"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "procollagen_type_1_n_terminal_propeptide",
      "panel_keys": [
        "bone_metabolism"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "progesterone",
      "panel_keys": [
        "reproductive_hormones"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "prolactin",
      "panel_keys": [
        "reproductive_hormones"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "protein_c_activity",
      "panel_keys": [
        "coagulation"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "protein_s_activity",
      "panel_keys": [
        "coagulation"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "prothrombin_time",
      "panel_keys": [
        "coagulation"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "psa_free",
      "panel_keys": [
        "tumor_markers"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "psa_free_total_ratio",
      "panel_keys": [
        "tumor_markers"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "psa_total",
      "panel_keys": [
        "tumor_markers"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "rbc_count",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "rbc_morphology",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "rdw_cv",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "rdw_sd",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "red_cell_antibody_identification",
      "panel_keys": [
        "blood_group_immunohematology"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "red_cell_antibody_screen",
      "panel_keys": [
        "blood_group_immunohematology"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "remnant_cholesterol",
      "panel_keys": [
        "lipid"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "renin_activity",
      "panel_keys": [
        "pituitary_adrenal"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "renin_concentration",
      "panel_keys": [
        "pituitary_adrenal"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "respiratory_pathogen_pcr",
      "panel_keys": [
        "microbiology_molecular"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "reticulocyte_hemoglobin",
      "panel_keys": [
        "reticulocyte_hemoglobinopathy",
        "iron_studies"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "reticulocytes_absolute",
      "panel_keys": [
        "reticulocyte_hemoglobinopathy"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "reticulocytes_percent",
      "panel_keys": [
        "reticulocyte_hemoglobinopathy"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "reverse_t3",
      "panel_keys": [
        "thyroid"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "rhd_type",
      "panel_keys": [
        "blood_group_immunohematology"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "rheumatoid_factor",
      "panel_keys": [
        "immunology_autoimmune"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "rpr_qualitative",
      "panel_keys": [
        "infectious_serology"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "rpr_titer",
      "panel_keys": [
        "infectious_serology"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "selenium",
      "panel_keys": [
        "vitamins_minerals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "semen_leukocytes",
      "panel_keys": [
        "reproductive_semen"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "semen_liquefaction_time",
      "panel_keys": [
        "reproductive_semen"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "semen_ph",
      "panel_keys": [
        "reproductive_semen"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "semen_viscosity",
      "panel_keys": [
        "reproductive_semen"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "semen_volume",
      "panel_keys": [
        "reproductive_semen"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "seventeen_hydroxyprogesterone",
      "panel_keys": [
        "reproductive_hormones"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "shbg",
      "panel_keys": [
        "reproductive_hormones"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "sirolimus",
      "panel_keys": [
        "therapeutic_drug_monitoring"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "small_ldl_particle_number",
      "panel_keys": [
        "lipid"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "sodium",
      "panel_keys": [
        "renal_electrolytes"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "soluble_transferrin_receptor",
      "panel_keys": [
        "iron_studies"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "sperm_agglutination",
      "panel_keys": [
        "reproductive_semen"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "sperm_concentration",
      "panel_keys": [
        "reproductive_semen"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "sperm_dna_fragmentation_index",
      "panel_keys": [
        "reproductive_semen"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "sperm_immotile_percent",
      "panel_keys": [
        "reproductive_semen"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "sperm_nonprogressive_motility",
      "panel_keys": [
        "reproductive_semen"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "sperm_normal_morphology",
      "panel_keys": [
        "reproductive_semen"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "sperm_progressive_motility",
      "panel_keys": [
        "reproductive_semen"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "sperm_total_count",
      "panel_keys": [
        "reproductive_semen"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "sperm_total_motility",
      "panel_keys": [
        "reproductive_semen"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "sperm_vitality",
      "panel_keys": [
        "reproductive_semen"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "stool_clostridioides_difficile_toxin",
      "panel_keys": [
        "stool_digestive"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "stool_collection_duration",
      "panel_keys": [
        "stool_digestive"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "stool_collection_mass",
      "panel_keys": [
        "stool_digestive"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "stool_helicobacter_pylori_antigen",
      "panel_keys": [
        "stool_digestive"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "stool_hemoglobin_fit",
      "panel_keys": [
        "stool_digestive"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "stool_occult_blood_guaiac",
      "panel_keys": [
        "stool_digestive"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "stool_ova_parasites",
      "panel_keys": [
        "stool_digestive"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "stool_ph",
      "panel_keys": [
        "stool_digestive"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "stool_rbc",
      "panel_keys": [
        "stool_digestive"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "stool_reducing_substances",
      "panel_keys": [
        "stool_digestive"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "stool_wbc",
      "panel_keys": [
        "stool_digestive"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "syphilis_treponemal_antibody",
      "panel_keys": [
        "infectious_serology"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "tacrolimus",
      "panel_keys": [
        "therapeutic_drug_monitoring"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "testosterone_bioavailable",
      "panel_keys": [
        "reproductive_hormones"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "testosterone_free",
      "panel_keys": [
        "reproductive_hormones"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "testosterone_total",
      "panel_keys": [
        "reproductive_hormones"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "thrombin_time",
      "panel_keys": [
        "coagulation"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "thyroglobulin",
      "panel_keys": [
        "thyroid"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "thyroglobulin_antibodies",
      "panel_keys": [
        "thyroid"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "thyroid_stimulating_immunoglobulin",
      "panel_keys": [
        "thyroid"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "tibc",
      "panel_keys": [
        "iron_studies"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "tissue_transglutaminase_iga",
      "panel_keys": [
        "celiac"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "tissue_transglutaminase_igg",
      "panel_keys": [
        "celiac"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "total_cholesterol",
      "panel_keys": [
        "lipid"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "total_cholesterol_hdl_ratio",
      "panel_keys": [
        "lipid"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "total_protein",
      "panel_keys": [
        "liver_protein"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "total_t3",
      "panel_keys": [
        "thyroid"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "total_t4",
      "panel_keys": [
        "thyroid"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "tpo_antibodies",
      "panel_keys": [
        "thyroid"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "transferrin",
      "panel_keys": [
        "iron_studies"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "transferrin_saturation",
      "panel_keys": [
        "iron_studies"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "triglyceride_hdl_ratio",
      "panel_keys": [
        "lipid"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "triglycerides",
      "panel_keys": [
        "lipid"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "troponin_i",
      "panel_keys": [
        "cardiac_muscle"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "troponin_t",
      "panel_keys": [
        "cardiac_muscle"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "tsh",
      "panel_keys": [
        "thyroid"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "tsh_receptor_antibodies",
      "panel_keys": [
        "thyroid"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "uibc",
      "panel_keys": [
        "iron_studies"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urea",
      "panel_keys": [
        "renal_electrolytes"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "uric_acid",
      "panel_keys": [
        "renal_electrolytes"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_albumin",
      "panel_keys": [
        "urine_quantitative"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_albumin_creatinine_ratio",
      "panel_keys": [
        "renal_electrolytes",
        "urine_quantitative",
        "urinalysis"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_albumin_excretion_rate",
      "panel_keys": [
        "urine_quantitative"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_bacteria",
      "panel_keys": [
        "urinalysis"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_bilirubin",
      "panel_keys": [
        "urinalysis"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_blood",
      "panel_keys": [
        "urinalysis"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_calcium_24h",
      "panel_keys": [
        "urine_quantitative"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_calcium_concentration",
      "panel_keys": [
        "urine_quantitative"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_clarity",
      "panel_keys": [
        "urinalysis"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_collection_duration",
      "panel_keys": [
        "urine_quantitative"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_collection_volume",
      "panel_keys": [
        "urine_quantitative"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_color",
      "panel_keys": [
        "urinalysis"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_cortisol_free_24h",
      "panel_keys": [
        "urine_quantitative"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_creatinine",
      "panel_keys": [
        "urine_quantitative"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_creatinine_24h",
      "panel_keys": [
        "urine_quantitative"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_crystals",
      "panel_keys": [
        "urinalysis"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_glucose",
      "panel_keys": [
        "urinalysis"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_granular_casts",
      "panel_keys": [
        "urinalysis"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_hyaline_casts",
      "panel_keys": [
        "urinalysis"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_ketones",
      "panel_keys": [
        "urinalysis"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_leukocyte_esterase",
      "panel_keys": [
        "urinalysis"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_mucus",
      "panel_keys": [
        "urinalysis"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_nitrite",
      "panel_keys": [
        "urinalysis"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_osmolality",
      "panel_keys": [
        "urine_quantitative"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_ph",
      "panel_keys": [
        "urinalysis"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_phosphate_24h",
      "panel_keys": [
        "urine_quantitative"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_phosphate_concentration",
      "panel_keys": [
        "urine_quantitative"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_potassium_24h",
      "panel_keys": [
        "urine_quantitative"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_potassium_concentration",
      "panel_keys": [
        "urine_quantitative"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_protein",
      "panel_keys": [
        "urinalysis"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_protein_24h",
      "panel_keys": [
        "urine_quantitative"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_protein_concentration",
      "panel_keys": [
        "urine_quantitative"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_protein_creatinine_ratio",
      "panel_keys": [
        "urine_quantitative"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_rbc",
      "panel_keys": [
        "urinalysis"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_rbc_casts",
      "panel_keys": [
        "urinalysis"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_renal_epithelial_cells",
      "panel_keys": [
        "urinalysis"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_sodium_24h",
      "panel_keys": [
        "urine_quantitative"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_sodium_concentration",
      "panel_keys": [
        "urine_quantitative"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_specific_gravity",
      "panel_keys": [
        "urinalysis"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_squamous_epithelial_cells",
      "panel_keys": [
        "urinalysis"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_transitional_epithelial_cells",
      "panel_keys": [
        "urinalysis"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_urea_nitrogen_24h",
      "panel_keys": [
        "urine_quantitative"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_uric_acid_24h",
      "panel_keys": [
        "urine_quantitative"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_uric_acid_concentration",
      "panel_keys": [
        "urine_quantitative"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_urobilinogen",
      "panel_keys": [
        "urinalysis"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_waxy_casts",
      "panel_keys": [
        "urinalysis"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_wbc",
      "panel_keys": [
        "urinalysis"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_wbc_casts",
      "panel_keys": [
        "urinalysis"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "urine_yeast",
      "panel_keys": [
        "urinalysis"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "valproic_acid_free",
      "panel_keys": [
        "therapeutic_drug_monitoring"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "valproic_acid_total",
      "panel_keys": [
        "therapeutic_drug_monitoring"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "vancomycin",
      "panel_keys": [
        "therapeutic_drug_monitoring"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "vitamin_a_retinol",
      "panel_keys": [
        "vitamins_minerals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "vitamin_b12",
      "panel_keys": [
        "vitamins_minerals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "vitamin_b1_thiamine",
      "panel_keys": [
        "vitamins_minerals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "vitamin_b1_thiamine_diphosphate",
      "panel_keys": [
        "vitamins_minerals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "vitamin_b2_riboflavin",
      "panel_keys": [
        "vitamins_minerals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "vitamin_b6_pyridoxal_phosphate",
      "panel_keys": [
        "vitamins_minerals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "vitamin_c",
      "panel_keys": [
        "vitamins_minerals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "vitamin_d_1_25_dihydroxy",
      "panel_keys": [
        "vitamins_minerals",
        "bone_metabolism"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "vitamin_d_25_oh_d2",
      "panel_keys": [
        "vitamins_minerals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "vitamin_d_25_oh_d3",
      "panel_keys": [
        "vitamins_minerals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "vitamin_d_25_oh_total",
      "panel_keys": [
        "vitamins_minerals",
        "bone_metabolism"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "vitamin_e_alpha_tocopherol",
      "panel_keys": [
        "vitamins_minerals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "vitamin_e_gamma_tocopherol",
      "panel_keys": [
        "vitamins_minerals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "vitamin_k1",
      "panel_keys": [
        "vitamins_minerals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "vldl_cholesterol",
      "panel_keys": [
        "lipid"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "wbc_count",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "wbc_morphology",
      "panel_keys": [
        "cbc"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    },
    {
      "analyte_key": "zinc",
      "panel_keys": [
        "vitamins_minerals"
      ],
      "definition_requirement": "Typed result, permitted specimen/method/scale qualifiers, reported-unit preservation; explicit tested normalization only. See v5 result and series contracts.",
      "external_codes": []
    }
  ],
  "measurement_groups": {
    "anthropometry_body_composition": [
      "weight",
      "height",
      "waist_circumference",
      "hip_circumference",
      "chest_circumference",
      "neck_circumference",
      "upper_arm_circumference",
      "thigh_circumference",
      "calf_circumference",
      "body_fat_percent",
      "fat_mass",
      "lean_mass",
      "fat_free_mass",
      "skeletal_muscle_mass",
      "appendicular_lean_mass",
      "body_water_percent",
      "total_body_water",
      "intracellular_water",
      "extracellular_water",
      "extracellular_total_water_ratio",
      "visceral_fat_area",
      "visceral_fat_level",
      "segmental_fat_mass",
      "segmental_lean_mass",
      "segmental_body_fat_percent",
      "phase_angle",
      "skinfold_thickness",
      "bmi",
      "waist_hip_ratio",
      "waist_height_ratio",
      "fat_mass_index",
      "fat_free_mass_index",
      "appendicular_lean_mass_index",
      "body_surface_area"
    ],
    "cardiovascular": [
      "blood_pressure",
      "heart_rate",
      "heart_rate_recovery",
      "hrv_sdnn",
      "hrv_rmssd",
      "hrv_pnn50",
      "pulse_pressure",
      "mean_arterial_pressure",
      "pulse_wave_velocity",
      "ankle_brachial_index",
      "pr_interval",
      "qrs_duration",
      "qt_interval",
      "qtc_interval",
      "p_axis",
      "qrs_axis",
      "t_axis",
      "atrial_fibrillation_burden",
      "premature_ventricular_contraction_count",
      "left_ventricular_ejection_fraction",
      "global_longitudinal_strain"
    ],
    "respiratory_temperature": [
      "oxygen_saturation",
      "respiratory_rate",
      "body_temperature",
      "skin_temperature",
      "skin_temperature_deviation",
      "peripheral_perfusion_index",
      "peak_expiratory_flow",
      "fev1",
      "fvc",
      "fev1_fvc_ratio",
      "fev1_vc_ratio",
      "fef25_75",
      "slow_vital_capacity",
      "total_lung_capacity",
      "residual_volume",
      "functional_residual_capacity",
      "diffusing_capacity_co",
      "carbon_monoxide_transfer_coefficient",
      "fractional_exhaled_nitric_oxide"
    ],
    "glucose_ketones": [
      "blood_glucose",
      "interstitial_glucose",
      "blood_beta_hydroxybutyrate",
      "blood_ketones",
      "breath_acetone"
    ],
    "fitness_function": [
      "vo2_max_absolute",
      "vo2_max_relative",
      "ventilatory_threshold_oxygen_uptake",
      "ventilatory_threshold_heart_rate",
      "ventilatory_threshold_power",
      "grip_strength",
      "gait_speed",
      "six_minute_walk_distance",
      "timed_up_and_go_duration",
      "sit_to_stand_repetitions",
      "sit_to_stand_duration",
      "single_leg_stance_duration"
    ],
    "bone": [
      "bone_mineral_density_areal",
      "bone_mineral_content",
      "bone_density_t_score",
      "bone_density_z_score"
    ],
    "vision_hearing": [
      "visual_acuity_snellen",
      "visual_acuity_logmar",
      "intraocular_pressure",
      "spherical_refraction",
      "cylindrical_refraction",
      "refraction_axis",
      "hearing_threshold"
    ],
    "study_summaries": [
      "cgm_summary",
      "ambulatory_bp_summary",
      "spirometry_summary",
      "body_composition_summary",
      "dxa_summary",
      "ecg_summary",
      "echocardiography_summary",
      "functional_test_summary"
    ]
  },
  "record_field_index": {
    "measurement": [
      "kind",
      "metric_key",
      "value",
      "unit",
      "original_value",
      "original_unit",
      "comparator",
      "uncertainty",
      "specimen",
      "measurement_site",
      "laterality",
      "body_position",
      "method",
      "device_context",
      "resting_state",
      "fasting_state",
      "time_since_meal_minutes",
      "exercise_context",
      "oxygen_context",
      "temperature_site",
      "source_reference_range",
      "reported_predicted_value",
      "reported_percent_predicted",
      "reported_lower_limit_normal",
      "reported_z_score",
      "reference_equation",
      "study_type",
      "components",
      "effective_period",
      "coverage",
      "specimen_context",
      "classification_metadata"
    ],
    "nutrition": [
      "entry_kind",
      "label",
      "nutrients",
      "nutrient_qualifiers",
      "component_details",
      "quantity_basis",
      "energy_method",
      "carbohydrate_definition",
      "fiber_method",
      "folate_basis",
      "vitamin_form_context",
      "related_record_ids",
      "notes"
    ],
    "hydration": [
      "entry_kind",
      "volume_ml",
      "drink_type",
      "description",
      "total_fluids_ml",
      "water_ml",
      "administration_route",
      "related_record_ids",
      "notes"
    ],
    "activity": [
      "entry_kind",
      "activity_type",
      "activity_label",
      "start_at",
      "end_at",
      "elapsed_seconds",
      "moving_seconds",
      "paused_seconds",
      "distance_m",
      "steps",
      "elevation_gain_m",
      "elevation_loss_m",
      "floors_ascended",
      "floors_descended",
      "average_speed_mps",
      "max_speed_mps",
      "average_pace_seconds_per_km",
      "treadmill_incline_percent",
      "average_heart_rate_bpm",
      "max_heart_rate_bpm",
      "min_heart_rate_bpm",
      "recovery_heart_rate_bpm",
      "recovery_interval_seconds",
      "energy_kcal",
      "energy_basis",
      "average_power_w",
      "max_power_w",
      "reported_normalized_power_w",
      "mechanical_work_kj",
      "cadence",
      "cadence_unit",
      "stride_length_m",
      "ground_contact_time_ms",
      "vertical_oscillation_cm",
      "vertical_ratio_percent",
      "ground_contact_balance_percent",
      "training_context",
      "exertion",
      "heart_rate_zones",
      "power_zones",
      "segments",
      "rowing",
      "swimming",
      "strength",
      "daily_totals",
      "notes"
    ],
    "sleep": [
      "entry_kind",
      "session_type",
      "start_at",
      "end_at",
      "time_in_bed_seconds",
      "sleep_seconds",
      "sleep_latency_seconds",
      "rem_latency_seconds",
      "waso_seconds",
      "awake_seconds",
      "awakenings",
      "sleep_efficiency_percent",
      "stage_durations",
      "stage_system",
      "stage_intervals",
      "quality",
      "device_sleep_score",
      "snoring",
      "breathing_interruptions",
      "heart_rate_summary",
      "respiratory_rate_summary",
      "oxygen_summary",
      "study_metadata",
      "respiratory_events",
      "arousals",
      "limb_movements",
      "body_position_summary",
      "pap_session",
      "recorded_environment",
      "notes"
    ],
    "checkin": [
      "ratings",
      "symptoms",
      "diary_completeness",
      "gastrointestinal",
      "urinary",
      "reproductive",
      "assessment_results",
      "actual_fasting_interval",
      "pain_function_context",
      "notes"
    ],
    "intake": [
      "product_name",
      "category",
      "product_type",
      "status",
      "administered_quantity",
      "dosage_form",
      "ingredients",
      "route",
      "site",
      "start_at",
      "end_at",
      "duration_seconds",
      "administered_volume_ml",
      "administration_rate",
      "taken_with_food",
      "source_intake_reason",
      "missed_skipped_reason",
      "related_record_ids",
      "nutrient_contributions",
      "nutrient_qualifiers",
      "reported_reaction",
      "notes"
    ],
    "lab_result": [
      "analyte_kind",
      "analyte_key",
      "original_analyte_name",
      "external_codes",
      "result",
      "original_result_text",
      "unit",
      "original_unit",
      "source_status",
      "data_absent_reason",
      "specimen",
      "collection_period",
      "collected_at",
      "received_at",
      "analyzed_at",
      "reported_at",
      "laboratory",
      "method",
      "instrument",
      "assay_version",
      "detection_limit",
      "quantification_limit",
      "reference_ranges",
      "source_flags",
      "source_interpretation",
      "fasting_context",
      "challenge_context",
      "sampling_context",
      "report_reference",
      "report_revision",
      "original_panel_label",
      "panel_keys",
      "specimen_reference",
      "related_result_ids",
      "source_reference"
    ]
  },
  "sources": [
    {
      "id": "R1",
      "title": "MCP official server tools specification",
      "url": "https://modelcontextprotocol.io/specification/2026-07-28/server/tools",
      "scope": "Protocol operation schemas and discovery; not a health terminology."
    },
    {
      "id": "R2",
      "title": "OpenAPI Specification 3.1.1",
      "url": "https://spec.openapis.org/oas/v3.1.1.html",
      "scope": "Versioned API schema reference, not a claim about the newest OpenAPI release."
    },
    {
      "id": "S01",
      "title": "USDA FoodData Central Foundation Foods documentation",
      "url": "https://fdc.nal.usda.gov/Foundation_Foods_Documentation/",
      "scope": "Component forms, reporting bases, unavailable nutrients, analytical method distinctions."
    },
    {
      "id": "S02",
      "title": "USDA National Agricultural Library: nutrient lists, SR Legacy 2018",
      "url": "https://www.nal.usda.gov/human-nutrition-and-food-safety/nutrient-lists-standard-reference-legacy-2018",
      "scope": "Additional food-component and amino-acid coverage. Historical version, not a live food-data integration."
    },
    {
      "id": "S03",
      "title": "FAO/INFOODS food component identifiers",
      "url": "https://www.fao.org/infoods/infoods/standards-guidelines/food-component-identifiers-tagnames/en/",
      "scope": "Precisely distinguish components and expression bases; no unverified tag mappings are required."
    },
    {
      "id": "S04",
      "title": "FDA industry resources for Nutrition Facts labels",
      "url": "https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/industry-resources-changes-nutrition-facts-label",
      "scope": "Label nutrient families, soluble/insoluble fibre and sugar-alcohol fields; not a labeling-compliance implementation."
    },
    {
      "id": "S05",
      "title": "NIH Office of Dietary Supplements: Folate, health professional",
      "url": "https://ods.od.nih.gov/factsheets/Folate-HealthProfessional/",
      "scope": "Folate forms and DFE are not identical quantities."
    },
    {
      "id": "S06",
      "title": "NIH Office of Dietary Supplements: Vitamin A, health professional",
      "url": "https://ods.od.nih.gov/factsheets/VitaminA-HealthProfessional/",
      "scope": "Retinol activity equivalents and carotenoid forms."
    },
    {
      "id": "S07",
      "title": "NIH Office of Dietary Supplements: Vitamin E, health professional",
      "url": "https://ods.od.nih.gov/factsheets/VitaminE-HealthProfessional/",
      "scope": "Form-specific vitamin E expression; no generic IU-to-mass conversion."
    },
    {
      "id": "S08",
      "title": "ICMR-NIN achievements: Indian Food Composition Tables 2017 description",
      "url": "https://www.nin.res.in/achievements.html",
      "scope": "Indian-context coverage cross-check. The official descriptive page was reviewed; the full IFCT book was not reviewed."
    },
    {
      "id": "S09",
      "title": "Dr Lal PathLabs official comprehensive dummy report WM17S",
      "url": "https://cdn1.lalpathlabs.com/live/reports/WM17S.pdf",
      "scope": "Selected report pages visually reviewed: chemistry, vitamin tests, HbA1c/eAG, CBC, revised-report notation. No patient values copied."
    },
    {
      "id": "S10",
      "title": "Labcorp comprehensive metabolic panel: test description and sample report",
      "url": "https://www.labcorp.com/tests/322000/metabolic-panel-14-comprehensive",
      "scope": "Panel constituents and reporting conventions; sample first page visually reviewed at https://files.labcorp.com/testmenu-d8/sample_reports/322000.pdf."
    },
    {
      "id": "S11",
      "title": "Labcorp comprehensive pre-bariatric profile: test description and sample report",
      "url": "https://www.labcorp.com/tests/259141/pre-bariatric-surgery-comprehensive-profile",
      "scope": "Broader nutritional/laboratory fields; sample first two pages visually reviewed at https://files.labcorp.com/testmenu-d8/sample_reports/259141.pdf. Not a recommendation to order that profile."
    },
    {
      "id": "S12",
      "title": "Mayo Clinic Laboratories thyroid function cascade",
      "url": "https://www.mayocliniclabs.com/test-catalog/overview/83633/thyroid-function-cascade-serum",
      "scope": "Distinct thyroid assays and an official sample report; source sample page visually reviewed."
    },
    {
      "id": "S13",
      "title": "HL7 FHIR R4 Observation",
      "url": "https://hl7.org/fhir/R4/observation.html",
      "scope": "Design reference for result variants, absence reasons, components and reference-range context. This service is not a FHIR server."
    },
    {
      "id": "S14",
      "title": "HL7 FHIR R4 DiagnosticReport",
      "url": "https://hl7.org/fhir/R4/diagnosticreport.html",
      "scope": "Report grouping, result status and effective versus issued dates; no document-storage feature."
    },
    {
      "id": "S15",
      "title": "LOINC users guide: major parts of a term",
      "url": "https://loinc.org/kb/users-guide/major-parts-of-a-loinc-term",
      "scope": "Analyte/property/time/specimen/scale/method distinctions. Do not publish guessed clinical codes."
    },
    {
      "id": "S16",
      "title": "UCUM specification",
      "url": "https://ucum.org/ucum",
      "scope": "Unit representation and dimensional meaning; assay equivalence must be checked separately."
    },
    {
      "id": "S17",
      "title": "International Diabetes Center: AGP report examples",
      "url": "https://www.agpreport.org/agp/agpreports",
      "scope": "Interval-based glucose summaries and coverage metadata. Displayed clinical targets are not adopted as application targets."
    },
    {
      "id": "S18",
      "title": "American Thoracic Society: interpreting sleep studies primer",
      "url": "https://www.thoracic.org/professionals/clinical-resources/sleep/sleep-modules/interpreting-sleep-studies-primer.php",
      "scope": "Sleep-study result families, respiratory indices and oxygen reporting; no diagnostic thresholds adopted."
    },
    {
      "id": "S19",
      "title": "InBody official result-sheet explanation",
      "url": "https://www.inbody.in/result-sheet.php",
      "scope": "Segmental composition and source-specific body-composition quantities; no vendor score or target claims adopted."
    },
    {
      "id": "S20",
      "title": "Garmin official running-dynamics manual",
      "url": "https://www8.garmin.com/manuals-apac/webhelp/fenix7series/EN-SG/GUID-0EEB4D15-92ED-48EB-B938-3873B4FD6BA4-8922.html",
      "scope": "Running-dynamics measurement families. No wearable integration is required."
    },
    {
      "id": "S21",
      "title": "HL7 FHIR R4 MedicationAdministration",
      "url": "https://hl7.org/fhir/R4/medicationadministration.html",
      "scope": "Actual administration period, route, dose, site and rate; no prescription planning."
    },
    {
      "id": "S22",
      "title": "Labcorp coagulation/DIC profile",
      "url": "https://www.labcorp.com/tests/116012/disseminated-intravascular-coagulation-dic-profile",
      "scope": "Coagulation analyte family coverage, not a screening recommendation."
    },
    {
      "id": "S23",
      "title": "Mayo Clinic Laboratories HEp-2 antinuclear antibodies",
      "url": "https://www.mayocliniclabs.com/test-catalog/overview/65161/antinuclear-antibodies-hep-2-substrate-igg-serum",
      "scope": "Antibody result forms, titers and patterns."
    },
    {
      "id": "S24",
      "title": "Labcorp gastrointestinal stool PCR profile",
      "url": "https://www.labcorp.com/tests/183480/gastrointestinal-profile-stool-pcr",
      "scope": "Organism-specific qualitative molecular results."
    },
    {
      "id": "S25",
      "title": "Labcorp quantitative fecal fat",
      "url": "https://www.labcorp.com/tests/001354/fecal-fat-quantitative",
      "scope": "Collection duration and excretion-rate versus concentration distinctions."
    },
    {
      "id": "S26",
      "title": "USDA National Agricultural Library: food composition",
      "url": "https://www.nal.usda.gov/human-nutrition-and-food-safety/food-composition",
      "scope": "Specialized food-component families, including choline, isoflavones and purines."
    },
    {
      "id": "S27",
      "title": "ATS/ERS Standardization of Spirometry, 2019 technical statement",
      "url": "https://pmc.ncbi.nlm.nih.gov/articles/PMC6794117/",
      "scope": "Primary technical statement for spirometry measurement/report structure, not a diagnostic implementation."
    },
    {
      "id": "S28",
      "title": "International Society for Clinical Densitometry: official adult positions",
      "url": "https://iscd.org/official-positions-2023/",
      "scope": "DXA site, BMD, T-score/Z-score and report comparability; no clinical thresholds implemented."
    },
    {
      "id": "S29",
      "title": "Mayo Clinic Laboratories semen analysis with strict morphology",
      "url": "https://www.mayocliniclabs.com/test-catalog/overview/60556/semen-analysis-with-strict-morphology-semen",
      "scope": "Semen quantity, motility and morphology are different reported measurements."
    },
    {
      "id": "S30",
      "title": "Labcorp cancer antigen CA 125 test definition",
      "url": "https://www.labcorp.com/tests/002303/cancer-antigen-ca-125",
      "scope": "Assay-specific tumor-marker result identity; inclusion is not a recommendation for screening."
    }
  ],
  "not_included": [
    "Personal records",
    "Patient-specific targets or reference limits",
    "Food composition values",
    "A running API",
    "Complete generated JSON Schemas",
    "Unverified LOINC/INFOODS mappings",
    "Runtime schema mutation"
  ],
  "acceptance_test_count": 76
}
```
