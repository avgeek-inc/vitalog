"use client";

import { Widget } from "./ui/widget";
import { useAccount } from "./account-context";
import { useDayProgress } from "./use-day-progress";
import { formatDateTime } from "../lib/date-time";
import { HealthIcon, type HealthIconKind } from "./health-icon";
import { GoalMeter, MetricCard, MetricValue } from "./metric-card";
import { Logs } from "./logs";
import {
  activityActual,
  logView,
  moodLabels,
  object,
  sortRecords,
  type Data,
  type GoalProgress,
  type HealthRecord,
} from "../lib/health";

export function DailyView({
  date,
  timezone,
  summary,
  goals,
  records,
}: {
  date: string;
  timezone: string;
  summary: Data;
  goals: GoalProgress[];
  records: HealthRecord[];
}) {
  const { preferences } = useAccount();
  const dayProgress = useDayProgress(date, timezone);
  const byMetric = new Map(
    goals.map((progress) => [progress.goal.metric, progress]),
  );
  const nutrition = object(summary.nutrition);
  const actual = (metric: string, fallback: unknown) =>
    byMetric.has(metric) ? byMetric.get(metric)!.actual : fallback;
  const exact = (value: unknown) => {
    const source = object(value);
    return source.exact_decimal ?? source.exact_value;
  };
  const water = actual(
    "hydration:water_ml",
    exact(object(summary.hydration).water_ml),
  );
  const calories = actual(
    "activity:active_energy_kcal",
    activityActual(summary, records, false),
  );
  const minutes = actual(
    "activity:exercise_minutes",
    activityActual(summary, records, true),
  );
  const mood = String(object(object(summary.checkin).latest_mood).value ?? "");
  const macros: { key: string; title: string; kind: HealthIconKind }[] = [
    { key: "protein_g", title: "Protein", kind: "protein" },
    { key: "carbohydrate_g", title: "Carbs", kind: "carbs" },
    { key: "fat_g", title: "Fat", kind: "fat" },
    { key: "fiber_g", title: "Fiber", kind: "fiber" },
  ];
  return (
    <>
      <div className="daily-layout">
        <section className="daily-metrics" aria-label="Daily summary">
          <MetricCard
            title="Daily nutrition"
            icon={<HealthIcon kind="nutrition" />}
            value={actual("nutrient:energy_kcal", exact(nutrition.energy))}
            unit="kcal"
            progress={byMetric.get("nutrient:energy_kcal")}
            dayProgress={dayProgress}
            className="nutrition-card"
          >
            <div className="macros">
              {macros.map(({ key, title, kind }) => (
                <div className="macro" key={key}>
                  <h3 className="metric-title">
                    <HealthIcon kind={kind} />
                    {title}
                  </h3>
                  <MetricValue
                    value={actual(
                      `nutrient:${key}`,
                      exact(object(nutrition.nutrients)[key]),
                    )}
                    unit="g"
                    target={byMetric.get(`nutrient:${key}`)?.goal.target}
                  />
                  <GoalMeter
                    title={title}
                    progress={byMetric.get(`nutrient:${key}`)}
                    dayProgress={dayProgress}
                  />
                </div>
              ))}
            </div>
          </MetricCard>
          <Widget className="metric-card mood-card" aria-label="Mood">
            <Widget.Header>
              <Widget.Title icon={<HealthIcon kind="mood" mood={mood} />}>
                <h2 className="font-medium">Mood</h2>
              </Widget.Title>
            </Widget.Header>
            <Widget.Content>
              <div className="metric-value mood-value">
                {moodLabels[mood] ?? "—"}
              </div>
            </Widget.Content>
          </Widget>
          <MetricCard
            title="Water"
            icon={<HealthIcon kind="water" />}
            value={water}
            unit="mL"
            progress={byMetric.get("hydration:water_ml")}
            dayProgress={dayProgress}
            dayProgressTone="water"
          />
          <MetricCard
            title="Calories burned"
            icon={<HealthIcon kind="calories" />}
            value={calories}
            unit="kcal"
            progress={byMetric.get("activity:active_energy_kcal")}
            dayProgress={dayProgress}
            dayProgressTone="exercise"
          />
          <MetricCard
            title="Active minutes"
            icon={<HealthIcon kind="exercise" />}
            value={minutes}
            unit="min"
            progress={byMetric.get("activity:exercise_minutes")}
            dayProgress={dayProgress}
            dayProgressTone="exercise"
          />
        </section>
        <Logs
          key={date}
          logs={sortRecords(records).map((record) => ({
            ...logView(record, timezone),
            time: record.occurred_at
              ? formatDateTime(record.occurred_at, preferences).time
              : null,
          }))}
        />
      </div>
    </>
  );
}
