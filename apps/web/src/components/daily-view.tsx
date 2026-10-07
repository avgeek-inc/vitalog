"use client";

import { Widget } from "./ui/widget";
import { useAccount } from "./account-context";
import { formatDateTime } from "../lib/date-time";
import {
  Droplet,
  Flame,
  HeartPulse,
  Clock,
  Frown as FaceSad,
  Meh as FaceNeutral,
  Smile as FaceSmile,
  Laugh as FaceFun,
  Beef,
  Wheat,
  Sprout,
} from "lucide-react";
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
  const MoodIcon =
    mood === "great"
      ? FaceFun
      : mood === "good"
        ? FaceSmile
        : ["low", "very_low"].includes(mood)
          ? FaceSad
          : FaceNeutral;
  const macros = [
    { key: "protein_g", title: "Protein", Icon: Beef },
    { key: "carbohydrate_g", title: "Carbs", Icon: Wheat },
    { key: "fat_g", title: "Fat", Icon: Droplet },
    { key: "fiber_g", title: "Fiber", Icon: Sprout },
  ];
  return (
    <>
      <div className="daily-layout">
        <section className="daily-metrics" aria-label="Daily summary">
          <MetricCard
            title="Daily nutrition"
            icon={<Flame aria-hidden="true" />}
            value={actual("nutrient:energy_kcal", exact(nutrition.energy))}
            unit="kcal"
            progress={byMetric.get("nutrient:energy_kcal")}
            className="nutrition-card"
          >
            <div className="macros">
              {macros.map(({ key, title, Icon }) => (
                <div className="macro" key={key}>
                  <h3 className="metric-title">
                    <Icon aria-hidden="true" />
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
                  />
                </div>
              ))}
            </div>
          </MetricCard>
          <Widget className="metric-card mood-card" aria-label="Mood">
            <Widget.Header>
              <Widget.Title icon={<MoodIcon aria-hidden="true" />}>
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
            icon={<Droplet aria-hidden="true" />}
            value={water}
            unit="mL"
            progress={byMetric.get("hydration:water_ml")}
          />
          <MetricCard
            title="Calories burned"
            icon={<HeartPulse aria-hidden="true" />}
            value={calories}
            unit="kcal"
            progress={byMetric.get("activity:active_energy_kcal")}
          />
          <MetricCard
            title="Active minutes"
            icon={<Clock aria-hidden="true" />}
            value={minutes}
            unit="min"
            progress={byMetric.get("activity:exercise_minutes")}
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
