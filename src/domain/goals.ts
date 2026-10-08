import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { Decimal } from "decimal.js";
import type { Database } from "../db/client.js";
import {
  goals,
  goalRevisions,
  goalIdempotency,
  healthRecords,
} from "../db/schema.js";
import { DomainError, fail, parse } from "../errors.js";
import { CATALOG_VERSION } from "../registry/definitions.js";
import {
  goalMetricByKey,
  goalMetrics,
  goalSchema,
  type Goal,
} from "../registry/goals.js";
import { idempotencyKey, type Operation } from "../registry/operations.js";
import { boundedResponse } from "./catalog.js";
import { hash } from "./canonical.js";
import { fromRow, WRITE_LOCK } from "./store.js";
import { localDate } from "./validation.js";
import type { Data } from "./types.js";
import { goalProgress, weightValue } from "./goal-progress.js";

const result = (goal: Goal, replay: boolean): Data => ({
  catalog_version: CATALOG_VERSION,
  goal,
  committed_version: goal.version,
  idempotent_replay: replay,
});
export class Goals {
  constructor(
    private db: Database,
    private timezone: string,
    private clock: () => Date = () => new Date(),
  ) {}
  async execute(operation: Operation, raw: Data): Promise<Data> {
    if (operation.mutation)
      return boundedResponse(await this.mutate(operation, raw));
    const input = parse(operation.input, raw) as Data;
    switch (operation.name) {
      case "health_get_goal_catalog":
        return { catalog_version: CATALOG_VERSION, metrics: goalMetrics };
      case "health_list_goals": {
        const rows = await this.db
          .select()
          .from(goals)
          .where(
            input.status === "all"
              ? undefined
              : sql`${goals.snapshot}->>'status' = ${input.status ?? "active"}`,
          )
          .orderBy(goals.metric)
          .limit(201);
        if (rows.length > 200)
          throw new DomainError(
            "LIMIT_EXCEEDED",
            "At most 200 goal metrics are supported",
          );
        return boundedResponse({
          catalog_version: CATALOG_VERSION,
          goals: rows.map((row) => row.snapshot),
          returned_count: rows.length,
        });
      }
      case "health_get_goal": {
        const [row] = await this.db
          .select()
          .from(goals)
          .where(eq(goals.id, String(input.id)));
        if (!row) throw new DomainError("NOT_FOUND", "Goal does not exist");
        const response: Data = {
          catalog_version: CATALOG_VERSION,
          goal: row.snapshot,
        };
        if (input.include_history) {
          const limit = Number(input.history_limit ?? 100);
          const history = await this.db
            .select()
            .from(goalRevisions)
            .where(
              and(
                eq(goalRevisions.goalId, row.id),
                input.history_before_version
                  ? sql`${goalRevisions.version} < ${input.history_before_version}`
                  : undefined,
              ),
            )
            .orderBy(desc(goalRevisions.version))
            .limit(limit + 1);
          response.history = history
            .slice(0, limit)
            .map((revision) => revision.snapshot);
          response.history_has_more = history.length > limit;
          response.history_next_version =
            history.length > limit ? history[limit - 1]!.version : null;
        }
        return boundedResponse(response);
      }
      case "health_get_goal_progress":
        return this.progress(String(input.date));
      default:
        throw new DomainError("NOT_FOUND", "Unknown goal operation");
    }
  }
  private async mutate(operation: Operation, raw: Data): Promise<Data> {
    const key = parse(idempotencyKey, raw.idempotency_key);
    const { idempotency_key: _key, ...domain } = raw;
    const digest = hash(domain);
    return this.db.transaction(async (tx) => {
      await tx.execute(WRITE_LOCK);
      const [committed] = await tx
        .select()
        .from(goalIdempotency)
        .where(
          and(
            eq(goalIdempotency.operation, operation.name),
            eq(goalIdempotency.idempotencyKey, key),
          ),
        );
      if (committed) {
        if (committed.requestHash !== digest)
          throw new DomainError(
            "IDEMPOTENCY_CONFLICT",
            "This key already committed a different request",
          );
        return result(committed.snapshot, true);
      }
      const command = parse(operation.input, raw) as Data;
      const archive = operation.name === "health_archive_goal";
      const [existing] = await tx
        .select()
        .from(goals)
        .where(
          archive
            ? eq(goals.id, String(command.id))
            : eq(goals.metric, String(command.metric)),
        )
        .for("update");
      if (archive && !existing)
        throw new DomainError("NOT_FOUND", "Goal does not exist");
      if ((existing?.version ?? 0) !== command.expected_version)
        throw new DomainError(
          "VERSION_CONFLICT",
          "Goal version has changed",
          [],
          { current_version: existing?.version ?? 0 },
        );
      if (existing?.version === 2_147_483_647)
        throw new DomainError("LIMIT_EXCEEDED", "Goal version limit reached");
      const now = this.clock();
      const today = localDate(now, this.timezone);
      if (existing && existing.snapshot.effective_on > today)
        throw new DomainError(
          "UNAVAILABLE",
          "Goal history is ahead of the server local date",
        );
      let goal: Goal;
      if (archive)
        goal = {
          ...existing!.snapshot,
          version: existing!.version + 1,
          status: "archived",
          effective_on: today,
          updated_at: now.toISOString(),
        };
      else {
        const metric = goalMetricByKey.get(String(command.metric))!;
        const unit = String(command.unit ?? metric.unit);
        if (!(metric.accepted_units as readonly string[]).includes(unit))
          fail("/unit", `Use ${metric.accepted_units.join(" or ")}`);
        const factor =
          unit === "lb" ? new Decimal("0.45359237") : new Decimal(1);
        const baseline =
          command.baseline === undefined
            ? (existing?.snapshot.baseline ?? null)
            : new Decimal(Number(command.baseline)).mul(factor).toNumber();
        if (metric.direction === "target" && baseline === null)
          fail(
            "/baseline",
            "Supply an explicit baseline weight in the input unit",
          );
        if (metric.direction !== "target" && command.baseline !== undefined)
          fail("/baseline", "Baseline applies only to weight goals");
        goal = {
          id: existing?.id ?? randomUUID(),
          metric: metric.metric,
          period: metric.period,
          direction: metric.direction,
          target: new Decimal(Number(command.target)).mul(factor).toNumber(),
          unit: metric.unit,
          baseline,
          version: (existing?.version ?? 0) + 1,
          status: "active",
          effective_on: today,
          created_at: existing?.snapshot.created_at ?? now.toISOString(),
          updated_at: now.toISOString(),
        };
      }
      parse(goalSchema, goal);
      if (existing)
        await tx
          .update(goals)
          .set({ version: goal.version, snapshot: goal })
          .where(eq(goals.id, goal.id));
      else
        await tx.insert(goals).values({
          id: goal.id,
          metric: goal.metric,
          version: goal.version,
          snapshot: goal,
        });
      await tx.insert(goalRevisions).values({
        goalId: goal.id,
        version: goal.version,
        effectiveOn: today,
        snapshot: goal,
      });
      await tx.insert(goalIdempotency).values({
        operation: operation.name,
        idempotencyKey: key,
        requestHash: digest,
        snapshot: goal,
      });
      return result(goal, false);
    });
  }
  private async progress(date: string): Promise<Data> {
    return this.db.transaction(
      async (tx) => {
        const effective = await tx
          .selectDistinctOn([goalRevisions.goalId])
          .from(goalRevisions)
          .where(lte(goalRevisions.effectiveOn, date))
          .orderBy(goalRevisions.goalId, desc(goalRevisions.version))
          .limit(201);
        if (effective.length > 200)
          throw new DomainError(
            "LIMIT_EXCEEDED",
            "At most 200 goal metrics are supported",
          );
        const selected = effective
          .map((row) => row.snapshot)
          .filter((goal) => goal.status === "active")
          .sort((a, b) => a.metric.localeCompare(b.metric));
        if (!selected.length)
          return {
            catalog_version: CATALOG_VERSION,
            date,
            timezone: this.timezone,
            progress: [],
          };
        const types = [
          ...new Set(
            selected.flatMap((goal) =>
              goal.metric.startsWith("nutrient:")
                ? ["nutrition" as const]
                : goal.metric.startsWith("hydration:")
                  ? ["hydration" as const]
                  : goal.metric.startsWith("activity:")
                    ? ["activity" as const]
                    : [],
            ),
          ),
        ];
        const day = types.length
          ? await tx
              .select()
              .from(healthRecords)
              .where(
                and(
                  eq(healthRecords.occurredOn, date),
                  eq(healthRecords.status, "active"),
                  inArray(healthRecords.recordType, types),
                ),
              )
              .limit(1001)
          : [];
        if (day.length > 1000)
          throw new DomainError(
            "LIMIT_EXCEEDED",
            "Goal progress requires at most 1000 records per day",
          );
        let weight;
        if (selected.some((goal) => goal.metric === "measurement:weight")) {
          const candidates = await tx
            .select()
            .from(healthRecords)
            .where(
              and(
                eq(healthRecords.recordType, "measurement"),
                eq(healthRecords.status, "active"),
                eq(healthRecords.validity, "valid"),
                lte(healthRecords.occurredOn, date),
                sql`${healthRecords.payload}->>'metric_key' = 'weight'`,
              ),
            )
            .orderBy(
              desc(healthRecords.occurredOn),
              sql`${healthRecords.occurredAt} desc nulls last`,
              desc(healthRecords.recordedAt),
              desc(healthRecords.id),
            )
            .limit(1001);
          weight = candidates
            .slice(0, 1000)
            .map(fromRow)
            .find((record) => weightValue(record) !== null);
          if (!weight && candidates.length > 1000)
            throw new DomainError(
              "LIMIT_EXCEEDED",
              "More than 1000 excluded weight records precede the latest usable observation",
            );
        }
        return boundedResponse({
          catalog_version: CATALOG_VERSION,
          date,
          timezone: this.timezone,
          progress: goalProgress(
            selected,
            day.map(fromRow),
            weight,
            date,
            this.timezone,
          ),
        });
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }
}
