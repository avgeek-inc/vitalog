"use client";

import { Card, ProgressBar } from "@heroui/react";
import type { ReactNode } from "react";
import { formatNumber, type GoalProgress } from "../lib/health";

export function GoalMeter({
  progress,
  title,
}: {
  progress?: GoalProgress;
  title: string;
}) {
  if (!progress || progress.progress_percent === null) return null;
  const { goal } = progress;
  const nearLimit =
    goal.direction === "maximum" &&
    progress.status !== "over_limit" &&
    progress.progress_percent >= 90 &&
    progress.progress_percent <= 100;
  return (
    <div className="goal-meter">
      <ProgressBar
        value={progress.progress_percent}
        data-goal-status={progress.status}
        data-near-limit={nearLimit || undefined}
        aria-label={`${title} ${goal.direction === "maximum" ? "limit utilization" : "goal progress"}`}
      >
        <ProgressBar.Track>
          <ProgressBar.Fill />
        </ProgressBar.Track>
      </ProgressBar>
    </div>
  );
}
export function MetricValue({
  value,
  unit,
  target,
  className = "",
}: {
  value: unknown;
  unit?: string;
  target?: unknown;
  className?: string;
}) {
  return (
    <div className={`metric-value ${className}`}>
      <span>{formatNumber(value)}</span>
      {unit || target !== undefined ? (
        <small>
          {target !== undefined ? <>/ {formatNumber(target)} </> : null}
          {unit}
        </small>
      ) : null}
    </div>
  );
}
export function MetricCard({
  title,
  icon,
  value,
  unit,
  progress,
  children,
  className = "",
}: {
  title: string;
  icon: ReactNode;
  value?: unknown;
  unit?: string;
  progress?: GoalProgress;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={`metric-card ${className}`} aria-label={title}>
      <Card.Header>
        <h2 className="metric-title">
          {icon}
          {title}
        </h2>
      </Card.Header>
      <Card.Content>
        <MetricValue value={value} unit={unit} target={progress?.goal.target} />
        <GoalMeter title={title} progress={progress} />
        {children}
      </Card.Content>
    </Card>
  );
}
