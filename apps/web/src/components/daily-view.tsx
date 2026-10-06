"use client";

import { Card } from "@heroui/react";
import Droplet from "@gravity-ui/icons/Droplet";
import Flame from "@gravity-ui/icons/Flame";
import HeartPulse from "@gravity-ui/icons/HeartPulse";
import Clock from "@gravity-ui/icons/Clock";
import FaceSad from "@gravity-ui/icons/FaceSad";
import FaceNeutral from "@gravity-ui/icons/FaceNeutral";
import FaceSmile from "@gravity-ui/icons/FaceSmile";
import FaceFun from "@gravity-ui/icons/FaceFun";
import { Beef, Wheat, Sprout } from "lucide-react";
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
          <Card className="metric-card mood-card" aria-label="Mood">
            <Card.Header>
              <h2 className="metric-title">
                <MoodIcon aria-hidden="true" />
                Mood
              </h2>
            </Card.Header>
            <Card.Content>
              <div className="metric-value mood-value">
                {moodLabels[mood] ?? "—"}
              </div>
            </Card.Content>
          </Card>
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
          logs={sortRecords(records).map((record) => logView(record, timezone))}
        />
      </div>
    </>
  );
}
