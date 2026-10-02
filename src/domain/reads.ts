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
import { CATALOG_VERSION } from "../registry/definitions.js";
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
} from "./summary.js";
import { localDate } from "./validation.js";
import { object, usable, type Data, type HealthRecord } from "./types.js";
import { Decimal } from "decimal.js";

const dayOffset = (date: string, days: number) =>
  new Date(new Date(`${date}T12:00:00Z`).getTime() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
const seriesDimensions = [
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
] as const;
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
        .limit(101);
      result.history = history.slice(0, 100).map((revision) => ({
        version: revision.version,
        snapshot: revision.snapshot,
        changed_at: new Date(revision.changedAt).toISOString(),
        reason: revision.reason,
      }));
      result.history_has_more = history.length > 100;
      result.history_next_version =
        history.length > 100 ? history[99]!.version : null;
    }
    return boundedResponse(result);
  }
  private async window(
    start: string,
    end: string,
    includeStudies = true,
  ): Promise<HealthRecord[]> {
    const rows = await this.store.db
      .select()
      .from(healthRecords)
      .where(
        and(
          eq(healthRecords.status, "active"),
          or(
            and(
              gte(healthRecords.occurredOn, start),
              lte(healthRecords.occurredOn, end),
            ),
            includeStudies
              ? sql`${healthRecords.payload} ? 'effective_period' or ${healthRecords.payload} ? 'collection_period' or ${healthRecords.payload}->>'entry_kind' = 'study_summary'`
              : undefined,
          ),
        ),
      )
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
        await this.window(date, date),
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
    const records = await this.window(start, end);
    const contextIdentity = sql`jsonb_build_object('unit', coalesce(payload->'value'->>'unit', payload->>'unit', 'unspecified'), ${sql.join(
      seriesDimensions.flatMap((dimension) => [
        sql`${dimension}::text`,
        sql`coalesce(payload->${dimension}::text, '"unspecified"'::jsonb)`,
      ]),
      sql`, `,
    )})`;
    const latestRows = await this.store.db.execute(sql`
      select distinct on (metric_key, context_identity) id from (
      select id, payload->>'metric_key' as metric_key, ${contextIdentity} as context_identity, occurred_on, occurred_at, recorded_at
      from health_records where record_type='measurement' and payload->>'kind'='scalar' and status='active' and validity='valid'
        and coalesce(payload->>'source_status','unknown') not in ('preliminary','cancelled')
        and coalesce(payload->'value'->>'kind','quantity') <> 'absent'
        and not exists (select 1 from jsonb_each(coalesce(provenance->'field_overrides','{}'::jsonb)) f
          where (f.key = '/value' or f.key like '/value/%') and f.value->>'validity' in ('suspect','invalid'))
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
          .filter((record) => usable(record, "/value"))
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
      records.some((record) => record.occurred_on === day),
    );
    return boundedResponse({
      catalog_version: CATALOG_VERSION,
      server_time: now.toISOString(),
      default_timezone: this.store.defaultTimezone,
      query_window: { start_date: start, end_date: end },
      latest_measurements: latest.map((record) => ({
        source_id: record.id,
        metric_key: record.data.metric_key,
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
        value: record.data.value,
        unit: record.data.unit,
        provenance: record.provenance,
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
    let records = await this.window(start, end);
    if (input.source_type)
      records = records.filter(
        (record) => record.provenance.source_type === input.source_type,
      );
    if (input.specimen_type)
      records = records.filter(
        (record) =>
          object(record.data.specimen).type === input.specimen_type ||
          record.data.specimen === input.specimen_type,
      );
    if (input.method_name)
      records = records.filter(
        (record) => object(record.data.method).name === input.method_name,
      );
    if (input.measurement_site)
      records = records.filter(
        (record) => record.data.measurement_site === input.measurement_site,
      );
    if (input.resting_state)
      records = records.filter(
        (record) => record.data.resting_state === input.resting_state,
      );
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
        const observations = dates.map((date) => {
          const day = dailySummary(records, date, this.store.defaultTimezone);
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
          }
          return {
            date,
            value: result.exact_value ?? null,
            exact_decimal: result.exact_decimal ?? null,
            basis: result.basis ?? "unknown",
            effective_result: result.effective_result ?? null,
            source_ids: result.source_ids ?? [],
            definition_basis: result.definition_basis ?? null,
            coverage: result.coverage ?? "only_supplied_values",
          };
        });
        for (const observation of observations) {
          if (observation.value === null && !observation.effective_result)
            continue;
          const identity = {
            metric,
            unit: key.startsWith("energy_") ? "kcal" : "encoded_in_metric",
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
          const valid = usable(record, valuePath, !!input.include_preliminary);
          const numeric =
            valid && !isStudy(record)
              ? point(value, record.data.comparator)
              : null;
          if (!numeric) exclusions++;
          group.observations.push({
            source_id: record.id,
            component_path: path.startsWith("/components") ? path : null,
            date: record.occurred_on,
            occurred_at: record.occurred_at,
            value: numeric?.toNumber() ?? null,
            exact_decimal: numeric?.toFixed() ?? null,
            supplied_result: value,
            source_status: record.data.source_status ?? "unknown",
            validity: record.validity,
            excluded_from_numeric: !numeric,
            period: isStudy(record) ? studyPeriod(record) : null,
            provenance: record.provenance,
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
                    value: mean?.toNumber() ?? null,
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
                        seven_day_moving_average: mean?.toNumber() ?? null,
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
        warnings,
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
