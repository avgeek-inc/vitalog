import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { healthRecords, revisions } from "../db/schema.js";
import { DomainError, fail, parse } from "../errors.js";
import {
  CATALOG_VERSION,
  nutrientDefinitions,
  recordTypes,
  seriesIdentityFields,
} from "../registry/definitions.js";
import { listInput } from "../registry/operations.js";
import { Cursors } from "./cursor.js";
import { boundedResponse } from "./catalog.js";
import { canonical } from "./canonical.js";
import { Store, fromRow } from "./store.js";
import {
  dailySummary,
  isStudy,
  point,
  studyPeriod,
  periodOverlapsDate,
  numericProjection,
} from "./summary.js";
import { localDate } from "./validation.js";
import {
  object,
  usable,
  valueKindAt,
  type Data,
  type HealthRecord,
} from "./types.js";
import { Decimal } from "decimal.js";

const dayOffset = (date: string, days: number) =>
  new Date(new Date(`${date}T12:00:00Z`).getTime() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
const seriesDimensions = seriesIdentityFields;
type WindowOptions = {
  sections?: string[];
  metrics?: string[];
  filters?: Data;
};
const intervalPeriod = sql`coalesce(
  ${healthRecords.payload}->'effective_period',
  ${healthRecords.payload}->'collection_period',
  ${healthRecords.payload}->'study_metadata'->'effective_period',
  case when ${healthRecords.recordType} = 'intake' then jsonb_build_object(
    'start', ${healthRecords.payload}->'start_at',
    'end', ${healthRecords.payload}->'end_at',
    'timezone', ${healthRecords.timezone}
  ) end
)`;
function periodDate(endpoint: "start" | "end"): SQL {
  const value = sql`(${intervalPeriod})->>${endpoint}`;
  return sql`case
    when ${value} like '%T%' then ((${value})::timestamptz at time zone coalesce((${intervalPeriod})->>'timezone', ${healthRecords.timezone}))::date
    when ${value} is not null then (${value})::date
    else null
  end`;
}
const intervalRecord = sql`(
  ${healthRecords.payload}->>'kind' = 'study_summary'
  or ${healthRecords.payload}->>'entry_kind' = 'study_summary'
  or ${healthRecords.payload} ? 'collection_period'
  or (${healthRecords.recordType} = 'intake' and (
    ${healthRecords.payload} ? 'effective_period'
    or (${healthRecords.payload}->>'start_at' is not null and ${healthRecords.payload}->>'end_at' is not null and ${periodDate("start")} <> ${periodDate("end")})
    or coalesce((${healthRecords.payload}->>'duration_seconds')::numeric, 0) >= 86400
  ))
)`;
function provenanceAt(record: HealthRecord, path: string): Data {
  const provenance: Data = { ...record.provenance };
  const component = path.startsWith("/components/")
    ? object(object(record.data.components)[path.split("/")[2]!])
    : {};
  const overrides = [
    object(component.provenance),
    ...Object.entries(record.provenance.field_overrides ?? {})
      .filter(([field]) => field === path || path.startsWith(field + "/"))
      .sort(([a], [b]) => a.length - b.length)
      .map(([, override]) => override),
  ];
  for (const override of overrides)
    for (const field of [
      "source_type",
      "value_kind",
      "source_description",
    ] as const)
      if (override[field] !== undefined) provenance[field] = override[field];
  return provenance;
}
export function dateRange(start: string, end: string): string[] {
  if (start > end) fail("/start_date", "Start date must not follow end date");
  const days =
    Math.floor(
      (new Date(end).getTime() - new Date(start).getTime()) / 86_400_000,
    ) + 1;
  if (days > 366)
    throw new DomainError(
      "LIMIT_EXCEEDED",
      "At most 366 calendar days per trend request",
    );
  return Array.from({ length: days }, (_, index) => dayOffset(start, index));
}
export class Reads {
  constructor(
    private store: Store,
    private cursors: Cursors,
  ) {}
  async list(raw: Data): Promise<Data> {
    const input = parse(listInput, raw);
    if (input.start_date && input.end_date && input.start_date > input.end_date)
      fail("/start_date", "Start date must not follow end date");
    const { cursor, ...filters } = {
      ...input,
      limit: input.limit ?? 50,
      status: input.status ?? "active",
    };
    const conditions: SQL[] = [];
    if (filters.status !== "all")
      conditions.push(eq(healthRecords.status, filters.status));
    if (input.record_types)
      conditions.push(inArray(healthRecords.recordType, input.record_types));
    const dates: SQL[] = [];
    if (input.start_date)
      dates.push(gte(healthRecords.occurredOn, input.start_date));
    if (input.end_date)
      dates.push(lte(healthRecords.occurredOn, input.end_date));
    if (dates.length)
      conditions.push(
        input.include_undated
          ? or(and(...dates), isNull(healthRecords.occurredOn))!
          : and(...dates)!,
      );
    if (input.source_type)
      conditions.push(
        sql`${healthRecords.provenance}->>'source_type' = ${input.source_type}`,
      );
    if (input.source_description)
      conditions.push(
        sql`${healthRecords.provenance}->>'source_description' = ${input.source_description}`,
      );
    if (input.validity)
      conditions.push(eq(healthRecords.validity, input.validity));
    if (input.metric_key)
      conditions.push(
        sql`${healthRecords.payload}->>'metric_key' = ${input.metric_key} or ${healthRecords.payload}->>'study_type' = ${input.metric_key}`,
      );
    if (input.analyte_key)
      conditions.push(
        sql`${healthRecords.payload}->>'analyte_key' = ${input.analyte_key}`,
      );
    if (input.custom_identity)
      conditions.push(
        sql`${healthRecords.payload}->>'custom_identity' = ${input.custom_identity}`,
      );
    if (cursor) {
      const position = this.cursors.decode(cursor, filters);
      if (position.date === null)
        conditions.push(
          sql`${healthRecords.occurredOn} is null and (${healthRecords.recordedAt}, ${healthRecords.id}) > (${String(position.recorded_at)}::timestamptz, ${String(position.id)}::uuid)`,
        );
      else
        conditions.push(
          sql`${healthRecords.occurredOn} is null or (${healthRecords.occurredOn}, ${healthRecords.recordedAt}, ${healthRecords.id}) > (${String(position.date)}::date, ${String(position.recorded_at)}::timestamptz, ${String(position.id)}::uuid)`,
        );
    }
    const rows = await this.store.db
      .select()
      .from(healthRecords)
      .where(and(...conditions))
      .orderBy(
        sql`${healthRecords.occurredOn} asc nulls last`,
        healthRecords.recordedAt,
        healthRecords.id,
      )
      .limit(filters.limit + 1);
    const records = rows.slice(0, filters.limit).map(fromRow);
    const last = records.at(-1);
    return boundedResponse({
      catalog_version: CATALOG_VERSION,
      records,
      returned_count: records.length,
      has_more: rows.length > filters.limit,
      next_cursor:
        rows.length > filters.limit && last
          ? this.cursors.encode(filters, {
              date: last.occurred_on,
              recorded_at: last.recorded_at,
              id: last.id,
            })
          : null,
    });
  }
  async record(input: Data): Promise<Data> {
    const [row] = await this.store.db
      .select()
      .from(healthRecords)
      .where(eq(healthRecords.id, String(input.id)));
    if (!row) throw new DomainError("NOT_FOUND", "Record does not exist");
    const result: Data = {
      catalog_version: CATALOG_VERSION,
      record: fromRow(row),
    };
    if (input.include_history) {
      const historyLimit = Number(input.history_limit ?? 100);
      const history = await this.store.db
        .select()
        .from(revisions)
        .where(
          and(
            eq(revisions.recordId, row.id),
            input.history_before_version
              ? sql`${revisions.version} < ${input.history_before_version}`
              : undefined,
          ),
        )
        .orderBy(desc(revisions.version))
        .limit(historyLimit + 1);
      result.history = history.slice(0, historyLimit).map((revision) => ({
        version: revision.version,
        snapshot: revision.snapshot,
        changed_at: new Date(revision.changedAt).toISOString(),
        reason: revision.reason,
      }));
      result.history_has_more = history.length > historyLimit;
      result.history_next_version =
        history.length > historyLimit
          ? history[historyLimit - 1]!.version
          : null;
    }
    return boundedResponse(result);
  }
  private async window(
    start: string,
    end: string,
    options: WindowOptions = {},
  ): Promise<HealthRecord[]> {
    const startOfPeriod = periodDate("start");
    const endOfPeriod = periodDate("end");
    const indexedDate = and(
      gte(healthRecords.occurredOn, start),
      lte(healthRecords.occurredOn, end),
    );
    const conditions: SQL[] = [
      eq(healthRecords.status, "active"),
      sql`(
        (not coalesce(${intervalRecord}, false) and ${indexedDate})
        or (${intervalRecord} and (
          (${startOfPeriod} is not null and ${endOfPeriod} is not null and ${startOfPeriod} <= ${end}::date and ${endOfPeriod} >= ${start}::date)
          or ((${startOfPeriod} is null or ${endOfPeriod} is null) and ${indexedDate})
        ))
      )`,
    ];
    if (options.sections)
      conditions.push(
        inArray(
          healthRecords.recordType,
          recordTypes.filter(
            (type) => type === "checkin" || options.sections!.includes(type),
          ),
        ),
      );
    if (options.metrics) {
      const categories = options.metrics.map((metric) => metric.split(":"));
      const requested: SQL[] = [];
      for (const [category, type] of [
        ["nutrient", "nutrition"],
        ["hydration", "hydration"],
        ["activity", "activity"],
        ["sleep", "sleep"],
      ] as const)
        if (categories.some(([name]) => name === category))
          requested.push(eq(healthRecords.recordType, type));
      const measurementKeys = categories
        .filter(([category]) => category === "measurement")
        .map(([, key]) => key!);
      if (measurementKeys.length)
        requested.push(sql`(${healthRecords.recordType} = 'measurement' and (
          ${healthRecords.payload}->>'metric_key' = any(${sql.param(measurementKeys)}::text[])
          or ${healthRecords.payload}->>'study_type' = any(${sql.param(measurementKeys)}::text[])
          or ${healthRecords.payload}->'components' ?| ${sql.param(measurementKeys)}::text[]
        ))`);
      const analyteKeys = categories
        .filter(([category]) => category === "lab")
        .map(([, key]) => key!);
      if (analyteKeys.length)
        requested.push(
          sql`(${healthRecords.recordType} = 'lab_result' and ${healthRecords.payload}->>'analyte_key' = any(${sql.param(analyteKeys)}::text[]))`,
        );
      conditions.push(or(...requested)!);
    }
    const filters = options.filters ?? {};
    if (filters.source_type)
      conditions.push(
        sql`${healthRecords.provenance}->>'source_type' = ${filters.source_type}`,
      );
    if (filters.specimen_type)
      conditions.push(
        sql`coalesce(${healthRecords.payload}->'specimen'->>'type', ${healthRecords.payload}->>'specimen') = ${filters.specimen_type}`,
      );
    if (filters.method_name)
      conditions.push(
        sql`${healthRecords.payload}->'method'->>'name' = ${filters.method_name}`,
      );
    if (filters.measurement_site)
      conditions.push(
        sql`${healthRecords.payload}->>'measurement_site' = ${filters.measurement_site}`,
      );
    if (filters.resting_state)
      conditions.push(
        sql`${healthRecords.payload}->>'resting_state' = ${filters.resting_state}`,
      );
    const rows = await this.store.db
      .select()
      .from(healthRecords)
      .where(and(...conditions))
      .orderBy(
        healthRecords.occurredOn,
        healthRecords.recordedAt,
        healthRecords.id,
      )
      .limit(1001);
    if (rows.length > 1000)
      throw new DomainError(
        "LIMIT_EXCEEDED",
        "Summary window exceeds 1000 records; use paginated record history or narrow the dates",
      );
    return rows.map(fromRow);
  }
  async daily(input: Data): Promise<Data> {
    const date = String(input.date);
    return boundedResponse(
      dailySummary(
        await this.window(date, date, {
          sections: input.sections as string[] | undefined,
        }),
        date,
        this.store.defaultTimezone,
        input.sections as string[] | undefined,
      ),
    );
  }
  async context(input: Data): Promise<Data> {
    const now = new Date();
    const end = localDate(now, this.store.defaultTimezone);
    const start = dayOffset(end, -(Number(input.lookback_days ?? 14) - 1));
    const requestedSections =
      (input.sections as string[] | undefined) ??
      recordTypes.filter((type) => type !== "lab_result");
    const records = await this.window(start, end, {
      sections: [
        ...requestedSections,
        ...(input.include_labs ? ["lab_result"] : []),
      ].filter((type) => type !== "lab_result" || input.include_labs),
    });
    const contextIdentity = sql`jsonb_build_object('unit', coalesce(payload->'value'->>'unit', payload->>'unit', 'unspecified'), ${sql.join(
      seriesDimensions.flatMap((dimension) => [
        sql`${dimension}::text`,
        sql`coalesce(payload->${dimension}::text, '"unspecified"'::jsonb)`,
      ]),
      sql`, `,
    )})`;
    const latestRows = await this.store.db.execute(sql`
      select distinct on (metric_key, context_identity) id from (
      select id, coalesce(payload->>'metric_key', case when payload->>'kind'='blood_pressure' then 'blood_pressure' end) as metric_key, ${contextIdentity} as context_identity, occurred_on, occurred_at, recorded_at
      from health_records where record_type='measurement' and payload->>'kind' in ('scalar','blood_pressure') and status='active' and validity='valid'
        and coalesce(payload->>'source_status','unknown') not in ('preliminary','cancelled')
        and coalesce(payload->'value'->>'kind','quantity') <> 'absent'
        and not exists (select 1 from jsonb_each(coalesce(provenance->'field_overrides','{}'::jsonb)) f
          where (f.key in ('/unit','/comparator') or (payload->>'kind'='scalar' and (f.key = '/value' or f.key like '/value/%'))
            or (payload->>'kind'='blood_pressure' and (f.key = '/systolic' or f.key like '/systolic/%' or f.key = '/diastolic' or f.key like '/diastolic/%')))
            and f.value->>'validity' in ('suspect','invalid'))
      ) candidates order by metric_key, context_identity, occurred_on desc nulls last, occurred_at desc nulls last, recorded_at desc, id desc limit 201
    `);
    const ids = latestRows.rows.map((row) => String(row.id));
    const latest = ids.length
      ? (
          await this.store.db
            .select()
            .from(healthRecords)
            .where(inArray(healthRecords.id, ids.slice(0, 200)))
        )
          .map(fromRow)
          .filter((record) =>
            record.data.kind === "blood_pressure"
              ? usable(record, "/systolic") && usable(record, "/diastolic")
              : usable(record, "/value"),
          )
      : [];
    const [labCounts] = await this.store.db
      .select({
        count: sql<number>`count(*)::int`,
        undated: sql<number>`count(*) filter (where ${healthRecords.occurredOn} is null)::int`,
      })
      .from(healthRecords)
      .where(
        and(
          eq(healthRecords.recordType, "lab_result"),
          eq(healthRecords.status, "active"),
        ),
      );
    const labs = records
      .filter((record) => record.record_type === "lab_result")
      .slice(-100);
    const recentDays = dateRange(start, end).filter((day) =>
      records.some((record) =>
        isStudy(record)
          ? periodOverlapsDate(record, day)
          : record.occurred_on === day,
      ),
    );
    return boundedResponse({
      catalog_version: CATALOG_VERSION,
      server_time: now.toISOString(),
      default_timezone: this.store.defaultTimezone,
      query_window: { start_date: start, end_date: end },
      latest_measurements: latest.map((record) => ({
        source_id: record.id,
        metric_key:
          record.data.metric_key ??
          (record.data.kind === "blood_pressure"
            ? "blood_pressure"
            : undefined),
        observed_on: record.occurred_on,
        age_days: record.occurred_on
          ? Math.floor(
              (new Date(end).getTime() -
                new Date(record.occurred_on).getTime()) /
                86_400_000,
            )
          : null,
        predates_query_window:
          !!record.occurred_on && record.occurred_on < start,
        value:
          record.data.kind === "blood_pressure"
            ? {
                kind: "blood_pressure",
                systolic: record.data.systolic,
                diastolic: record.data.diastolic,
                ...(record.data.pulse !== undefined && usable(record, "/pulse")
                  ? { pulse: record.data.pulse }
                  : {}),
                unit: record.data.unit,
              }
            : record.data.value,
        unit: record.data.unit,
        provenance:
          record.data.kind === "blood_pressure"
            ? record.provenance
            : provenanceAt(
                record,
                object(record.data.value).kind === "quantity"
                  ? "/value/value"
                  : "/value",
              ),
        series_context: seriesIdentity(record),
      })),
      recent_days: recentDays.map((date) =>
        dailySummary(
          records,
          date,
          this.store.defaultTimezone,
          (input.sections as string[] | undefined) ?? [
            "nutrition",
            "hydration",
            "activity",
            "sleep",
            "checkin",
            "intake",
            "measurement",
          ],
        ),
      ),
      ...(input.include_labs ? { recent_labs: labs } : {}),
      omitted_lab_count:
        (labCounts?.count ?? 0) - (input.include_labs ? labs.length : 0),
      undated_lab_count: labCounts?.undated ?? 0,
      warnings: latest.length ? [] : ["no_usable_measurements"],
      truncation: {
        has_more:
          ids.length > 200 ||
          (input.include_labs &&
            records.filter((record) => record.record_type === "lab_result")
              .length > 100) ||
          false,
        records_path: "/v1/records",
      },
    });
  }
  async trends(input: Data): Promise<Data> {
    const start = String(input.start_date),
      end = String(input.end_date);
    const dates = dateRange(start, end);
    const records = await this.window(start, end, {
      metrics: input.metrics as string[],
      filters: input,
    });
    const granularity = String(input.granularity ?? "day");
    const metrics = (input.metrics as string[]).map((metric) => {
      const [category, key] = metric.split(":") as [string, string];
      const series = new Map<
        string,
        { identity: Data; observations: Data[] }
      >();
      let exclusions = 0;
      const warnings: string[] = [];
      if (["nutrient", "hydration", "activity", "sleep"].includes(category)) {
        const observations = dates.flatMap((date) => {
          const day = dailySummary(records, date, this.store.defaultTimezone);
          const type = category === "nutrient" ? "nutrition" : category;
          const dayRecords = records.filter(
            (record) =>
              record.record_type === type &&
              record.occurred_on === date &&
              !isStudy(record),
          );
          let result: Data;
          if (category === "nutrient")
            result = key.startsWith("energy_")
              ? object(object(day.nutrition).energy)
              : object(object(object(day.nutrition).nutrients)[key]);
          else if (category === "hydration")
            result = object(object(day.hydration)[key]);
          else if (category === "sleep") result = object(day.sleep);
          else {
            const activity = object(day.activity);
            const daily = object(object(activity.reported_daily_totals).values);
            result =
              typeof daily[key] === "number"
                ? {
                    exact_value: daily[key],
                    exact_decimal: String(daily[key]),
                    source_ids: [
                      object(activity.reported_daily_totals).source_id,
                    ],
                    basis: "reported_daily_total",
                  }
                : key === "active_energy_kcal"
                  ? object(
                      object(object(activity.workout_subtotals).energy_kcal)
                        .active,
                    )
                  : object(object(activity.workout_subtotals)[key]);
            const sourceIds = (result.source_ids as string[] | undefined) ?? [];
            const path =
              result.basis === "reported_daily_total"
                ? `/daily_totals/${key}`
                : key === "active_energy_kcal"
                  ? "/energy_kcal"
                  : `/${key}`;
            result = {
              ...result,
              basis: result.basis ?? "known_workout_subtotal",
              estimated_count: dayRecords.filter(
                (record) =>
                  sourceIds.includes(record.id) &&
                  valueKindAt(record, path) === "estimated",
              ).length,
              missing_count: dayRecords.filter((record) => {
                const value =
                  record.data.entry_kind === "daily_total"
                    ? object(record.data.daily_totals)[key]
                    : record.data[
                        key === "active_energy_kcal" ? "energy_kcal" : key
                      ];
                return value === undefined || value === null;
              }).length,
              excluded_count: dayRecords.filter(
                (record) =>
                  !usable(
                    record,
                    record.data.entry_kind === "daily_total"
                      ? `/daily_totals/${key}`
                      : key === "active_energy_kcal"
                        ? "/energy_kcal"
                        : `/${key}`,
                  ),
              ).length,
              warnings: activity.warnings,
            };
          }
          const observation = {
            date,
            value: result.exact_value ?? null,
            exact_decimal: result.exact_decimal ?? null,
            basis: result.basis ?? "unknown",
            effective_result: result.effective_result ?? null,
            source_ids: result.source_ids ?? [],
            definition_basis: result.definition_basis ?? null,
            coverage: result.coverage ?? "only_supplied_values",
            estimated_count: result.estimated_count ?? 0,
            qualified_count: result.qualified_count ?? 0,
            missing_count: result.missing_count ?? 0,
            excluded_count: result.excluded_count ?? 0,
            provenance: dayRecords.map((record) => ({
              source_id: record.id,
              provenance: record.provenance,
              validity: record.validity,
            })),
            known_subtotals: result.known_intake_subtotals ?? [],
            qualified_results: result.qualified_results ?? [],
            warnings: result.warnings ?? [],
          };
          exclusions +=
            Number(observation.qualified_count) +
            Number(observation.excluded_count);
          warnings.push(...(observation.warnings as string[]));
          const subtotals = observation.known_subtotals as Data[];
          return result.basis === "incompatible_definition" && subtotals.length
            ? subtotals.map((subtotal) => ({
                ...observation,
                value: subtotal.exact_value ?? null,
                exact_decimal: subtotal.exact_decimal ?? null,
                effective_result:
                  subtotal.exact_value !== null &&
                  subtotal.exact_value !== undefined
                    ? {
                        kind: "exact",
                        value: subtotal.exact_value,
                        exact_decimal: subtotal.exact_decimal,
                      }
                    : null,
                basis: "known_intake_subtotal",
                definition_basis: subtotal.definition_basis ?? null,
                source_ids: subtotal.source_ids ?? [],
              }))
            : [observation];
        });
        for (const observation of observations) {
          if (
            observation.value === null &&
            !observation.effective_result &&
            !observation.qualified_count &&
            !observation.excluded_count &&
            !(observation.warnings as string[]).length
          )
            continue;
          const identity = {
            metric,
            unit: key.startsWith("energy_")
              ? "kcal"
              : category === "nutrient"
                ? nutrientDefinitions.find(
                    (definition) => definition.key === key,
                  )!.unit
                : category === "sleep"
                  ? "s"
                  : category === "hydration"
                    ? "mL"
                    : key === "active_energy_kcal"
                      ? "kcal"
                      : key === "distance_m"
                        ? "m"
                        : "1",
            definition_basis: observation.definition_basis ?? "unspecified",
          };
          const identityKey = canonical(identity);
          const group: { identity: Data; observations: Data[] } = series.get(
            identityKey,
          ) ?? { identity, observations: [] };
          group.observations.push(observation);
          series.set(identityKey, group);
        }
        if (!series.size)
          series.set(metric, {
            identity: { metric, definition_basis: "unspecified" },
            observations,
          });
      } else {
        for (const record of records) {
          if (
            !record.occurred_on ||
            (!isStudy(record) &&
              (record.occurred_on < start || record.occurred_on > end))
          )
            continue;
          if (
            isStudy(record) &&
            !dates.some((date) => periodOverlapsDate(record, date))
          )
            continue;
          let value: unknown,
            path = "/value";
          if (category === "measurement") {
            if (record.record_type !== "measurement") continue;
            if (record.data.metric_key === key) value = record.data.value;
            else if (
              record.data.kind === "study_summary" &&
              object(record.data.components)[key]
            ) {
              value = object(object(record.data.components)[key]).value;
              path = `/components/${key}/value`;
            } else if (record.data.study_type === key) value = record.data;
            else continue;
          } else {
            if (
              record.record_type !== "lab_result" ||
              record.data.analyte_key !== key
            )
              continue;
            value = record.data.result;
            path = "/result";
          }
          const identity = seriesIdentity(record, key);
          const id = canonical(identity);
          const group = series.get(id) ?? { identity, observations: [] };
          const valuePath =
            object(value).kind === "quantity" ? `${path}/value` : path;
          const rootPath = path.startsWith("/components/")
            ? path.slice(0, -"/value".length)
            : "";
          const valid = [
            valuePath,
            `${path}/unit`,
            `${path}/comparator`,
            `${rootPath}/unit`,
            `${rootPath}/comparator`,
          ].every((field) =>
            usable(record, field, !!input.include_preliminary),
          );
          const numeric =
            valid && !isStudy(record)
              ? point(value, record.data.comparator)
              : null;
          if (!numeric) exclusions++;
          const component = path.startsWith("/components/")
            ? object(object(record.data.components)[key])
            : {};
          group.observations.push({
            source_id: record.id,
            component_path: path.startsWith("/components") ? path : null,
            date: record.occurred_on,
            occurred_at: record.occurred_at,
            value: numeric ? numericProjection(numeric) : null,
            exact_decimal: numeric?.toFixed() ?? null,
            supplied_result: value,
            source_status:
              object(component.context).source_status ??
              record.data.source_status ??
              "unknown",
            validity: record.validity,
            excluded_from_numeric: !numeric,
            period: isStudy(record) ? studyPeriod(record) : null,
            provenance: provenanceAt(record, valuePath),
            ...(component.provenance
              ? { component_provenance: component.provenance }
              : {}),
            ...(component.validity
              ? { component_validity: component.validity }
              : {}),
          });
          series.set(id, group);
        }
        if (
          records.some((record) =>
            (
              record.data.related_record_ids as
                { relationship: string }[] | undefined
            )?.some(
              (link) => link.relationship === "alternative_representation",
            ),
          )
        )
          warnings.push("alternative_representations_preserved_individually");
        const projected = [...series.values()]
          .flatMap((group) => group.observations)
          .filter((obs) => obs.component_path);
        if (
          projected.length &&
          [...series.values()].some((group) =>
            group.observations.some((obs) => !obs.component_path),
          )
        )
          warnings.push("unresolved_representation_overlap");
      }
      const outputSeries = [...series.values()].map((group) => {
        const irregular =
          category === "lab" ||
          group.observations.some((observation) => observation.period);
        if (irregular)
          return {
            ...group,
            aggregation: "individual_irregular_observations",
            points: [],
          };
        const daily = dates.map((date) => {
          const values = group.observations.filter(
            (observation) =>
              observation.date === date && observation.value !== null,
          );
          const ordered = values.every(
            (observation) => typeof observation.occurred_at === "string",
          )
            ? [...values].sort(
                (a, b) =>
                  Date.parse(String(a.occurred_at)) -
                  Date.parse(String(b.occurred_at)),
              )
            : values;
          const last = ordered.at(-1);
          return {
            date,
            value: last?.value ?? null,
            exact_decimal: last?.exact_decimal ?? null,
            contributing_records: values.length,
            source_ids: values.flatMap(
              (observation) =>
                (observation.source_ids as string[] | undefined) ??
                (observation.source_id ? [String(observation.source_id)] : []),
            ),
          };
        });
        const points =
          granularity === "week"
            ? Array.from(
                { length: Math.ceil(daily.length / 7) },
                (_, index) => {
                  const days = daily.slice(index * 7, index * 7 + 7);
                  const known = days.filter((day) => day.value !== null);
                  const mean = known.length
                    ? known
                        .reduce(
                          (total, day) =>
                            total.plus(String(day.exact_decimal ?? day.value)),
                          new Decimal(0),
                        )
                        .div(known.length)
                    : null;
                  return {
                    start_date: days[0]!.date,
                    end_date: days.at(-1)!.date,
                    value: mean ? numericProjection(mean) : null,
                    contributing_days: known.length,
                    source_ids: days.flatMap((day) => day.source_ids),
                  };
                },
              )
            : daily.map((day, index) => {
                const days = daily
                  .slice(Math.max(0, index - 6), index + 1)
                  .filter((entry) => entry.value !== null);
                const mean = days.length
                  ? days
                      .reduce(
                        (total, entry) =>
                          total.plus(
                            String(entry.exact_decimal ?? entry.value),
                          ),
                        new Decimal(0),
                      )
                      .div(days.length)
                  : null;
                return {
                  ...day,
                  ...(metric === "measurement:weight"
                    ? {
                        seven_day_moving_average: mean
                          ? numericProjection(mean)
                          : null,
                        contributing_days: days.length,
                      }
                    : {}),
                };
              });
        return {
          ...group,
          aggregation:
            granularity === "week"
              ? "mean_of_daily_values_week_bins_start_at_requested_start"
              : "last_usable_per_local_day",
          points,
        };
      });
      const knownDates = new Set(
        [...series.values()]
          .flatMap((group) => group.observations)
          .filter((obs) => obs.value !== null && !obs.period)
          .map((obs) => obs.date),
      );
      return {
        metric,
        series: outputSeries,
        missing_dates: dates.filter((date) => !knownDates.has(date)),
        exclusions,
        warnings: [...new Set(warnings)],
      };
    });
    return boundedResponse({
      catalog_version: CATALOG_VERSION,
      start_date: start,
      end_date: end,
      granularity,
      metrics,
    });
  }
}
function seriesIdentity(record: HealthRecord, componentKey?: string): Data {
  const data = record.data;
  const unit =
    object(data.result ?? data.value).unit ?? data.unit ?? "unspecified";
  const base: Data = {
    ...Object.fromEntries(
      seriesDimensions.map((dimension) => [
        dimension,
        data[dimension] ?? "unspecified",
      ]),
    ),
    unit,
    period_type: isStudy(record) ? "interval" : "event",
    target: object(data.result).organism_or_target ?? "unspecified",
    isolate: object(data.result).isolate_reference ?? "unspecified",
    antimicrobial: object(data.result).antimicrobial ?? "unspecified",
  };
  if (componentKey && data.kind === "study_summary") {
    const component = object(object(data.components)[componentKey]);
    return {
      ...base,
      component_key: componentKey,
      component_unit:
        object(component.value).unit ?? component.unit ?? "unspecified",
      component_context: component.context ?? "unspecified",
    };
  }
  if (data.analyte_kind === "custom")
    base.custom_identity = data.custom_identity ?? record.id;
  return base;
}
