"use client";
import { Widget } from "./ui/widget";
import { Attributes } from "@avgeek-oss/design-system/data-display/attributes";
import { useAccount } from "./account-context";
import { formatDateTime } from "../lib/date-time";

import { Button } from "./ui/button";

import { ProgressBar } from "@heroui/react";
import { HealthIcon } from "./health-icon";
import { useState } from "react";
import {
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
  const { preferences } = useAccount();
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
          <Widget
            className="metric-card current-weight-card"
            aria-label="Current weight"
          >
            <Widget.Header>
              <Widget.Title>
                <h2 className="font-medium">Current weight</h2>
              </Widget.Title>
            </Widget.Header>
            <Widget.Content>
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
            </Widget.Content>
          </Widget>
          <Widget className="metric-card weight-trend-card">
            <Widget.Header>
              <Widget.Title icon={<HealthIcon kind="trend" />}>
                <h2 className="font-medium">Last 30 days</h2>
              </Widget.Title>
            </Widget.Header>
            <Widget.Content>
              <WeightChart records={sorted} today={today} />
            </Widget.Content>
          </Widget>
        </section>
        <section className="weight-history" aria-label="Weigh-ins">
          <Attributes
            title={<h2 className="font-medium">Weigh-ins</h2>}
            variant="list"
          >
            {sorted.length ? (
              sorted.slice(0, count).map((record) => {
                const exact = exactWeight(record);
                return (
                  <Attributes.Item
                    key={record.id}
                    label={
                      <time dateTime={record.occurred_on ?? undefined}>
                        {record.occurred_on
                          ? formatDateTime(record.occurred_on, preferences).date
                          : "Date not recorded"}
                      </time>
                    }
                  >
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
                  </Attributes.Item>
                );
              })
            ) : (
              <div className="p-4 text-sm text-muted">
                <dt className="sr-only">Weigh-ins</dt>
                <dd>No weigh-ins yet.</dd>
              </div>
            )}
          </Attributes>
          {sorted.length > count ? (
            <Button
              variant="ghost"
              className="history-more"
              onPress={() => setCount((value) => value + 30)}
            >
              Show more
            </Button>
          ) : null}
        </section>
      </div>
    </>
  );
}
