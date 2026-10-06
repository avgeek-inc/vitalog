"use client";

import { Button } from "./ui/button";

import { Card, ProgressBar } from "@heroui/react";
import ChartLine from "@gravity-ui/icons/ChartLine";
import ScalesBalanced from "@gravity-ui/icons/ScalesBalanced";
import { useState } from "react";
import {
  dateLabel,
  exactWeight,
  formatNumber,
  resultText,
  sortWeightRecords,
  usable,
  type GoalProgress,
  type HealthRecord,
} from "../lib/health";
import { MetricValue } from "./metric-card";
import { WeightChart } from "./weight-chart";

export function WeightView({
  records,
  progress,
  today,
}: {
  records: HealthRecord[];
  progress?: GoalProgress;
  today: string;
}) {
  const sorted = sortWeightRecords(records);
  const latest = sorted.find(
    (record) => record.occurred_on && exactWeight(record) !== null,
  );
  const current = progress
    ? progress.actual
    : latest
      ? exactWeight(latest)
      : null;
  const [count, setCount] = useState(30);
  return (
    <>
      <div className="weight-layout">
        <section className="weight-grid" aria-label="Weight overview">
          <Card
            className="metric-card current-weight-card"
            aria-label="Current weight"
          >
            <Card.Header>
              <h2 className="metric-title">
                <ScalesBalanced aria-hidden="true" />
                Current weight
              </h2>
            </Card.Header>
            <Card.Content>
              <MetricValue value={current} unit="kg" />
              {progress ? (
                <div className="goal-meter weight-goal">
                  <div className="goal-label">
                    <span>Start {formatNumber(progress.goal.baseline)} kg</span>
                    <span>Target {formatNumber(progress.goal.target)} kg</span>
                  </div>
                  {progress.progress_percent !== null ? (
                    <ProgressBar
                      value={progress.progress_percent}
                      data-goal-status={progress.status}
                      aria-label="Weight goal progress"
                    >
                      <ProgressBar.Track>
                        <ProgressBar.Fill />
                      </ProgressBar.Track>
                    </ProgressBar>
                  ) : null}
                </div>
              ) : null}
            </Card.Content>
          </Card>
          <Card className="metric-card weight-trend-card">
            <Card.Header>
              <h2 className="metric-title">
                <ChartLine aria-hidden="true" />
                Last 30 days
              </h2>
            </Card.Header>
            <Card.Content>
              <WeightChart records={sorted} today={today} />
            </Card.Content>
          </Card>
        </section>
        <Card className="logs-card weight-history">
          <Card.Header>
            <h2 className="section-title">Weigh-ins</h2>
          </Card.Header>
          <Card.Content>
            {sorted.length ? (
              <ul>
                {sorted.slice(0, count).map((record) => {
                  const exact = exactWeight(record);
                  return (
                    <li key={record.id} className="weight-reading">
                      <time dateTime={record.occurred_on ?? undefined}>
                        {record.occurred_on
                          ? dateLabel(record.occurred_on)
                          : "Date not recorded"}
                      </time>
                      <span>
                        {exact === null
                          ? usable(
                              record,
                              "/value",
                              "/value/value",
                              "/unit",
                              "/value/unit",
                              "/comparator",
                              "/value/comparator",
                            )
                            ? resultText(
                                record.data.value,
                                record.data.unit,
                                record.data.comparator,
                              )
                            : "—"
                          : `${formatNumber(exact)} kg`}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="empty-state">No weigh-ins yet.</p>
            )}
            {sorted.length > count ? (
              <Button
                variant="ghost"
                className="history-more"
                onPress={() => setCount((value) => value + 30)}
              >
                Show more
              </Button>
            ) : null}
          </Card.Content>
        </Card>
      </div>
    </>
  );
}
