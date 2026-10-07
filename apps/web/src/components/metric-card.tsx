"use client";

import { ProgressBar } from "@heroui/react";
import { Widget } from "./ui/widget";
import { useId, type ReactNode } from "react";
import { formatNumber, type GoalProgress } from "../lib/health";

type DayProgressTone = "nutrition" | "water" | "exercise";

export function GoalMeter({
  progress,
  title,
  dayProgress,
  dayProgressTone = "nutrition",
}: {
  progress?: GoalProgress;
  title: string;
  dayProgress?: number | null;
  dayProgressTone?: DayProgressTone;
}) {
  const descriptionId = useId();
  if (!progress) return null;
  const hasDayProgress = dayProgress !== undefined && dayProgress !== null;
  const { goal } = progress;
  const percent = progress.progress_percent ?? 0;
  const nearLimit =
    goal.direction === "maximum" &&
    progress.status !== "over_limit" &&
    percent >= 90 &&
    percent <= 100;
  return (
    <div className="goal-meter" data-metric={goal.metric}>
      <ProgressBar
        value={percent}
        data-goal-status={progress.status}
        data-near-limit={nearLimit || undefined}
        aria-label={`${title} ${goal.direction === "maximum" ? "limit utilization" : "goal progress"}`}
        aria-describedby={hasDayProgress ? descriptionId : undefined}
      >
        <ProgressBar.Track>
          <ProgressBar.Fill />
          {hasDayProgress ? (
            <span
              className="day-progress-dot"
              data-tone={dayProgressTone}
              aria-hidden="true"
              style={{ left: `${dayProgress}%` }}
            />
          ) : null}
        </ProgressBar.Track>
      </ProgressBar>
      {hasDayProgress ? (
        <span id={descriptionId} className="sr-only">
          {Math.floor(dayProgress)}% of the day elapsed
        </span>
      ) : null}
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
  dayProgress,
  dayProgressTone,
  children,
  className = "",
}: {
  title: string;
  icon: ReactNode;
  value?: unknown;
  unit?: string;
  progress?: GoalProgress;
  dayProgress?: number | null;
  dayProgressTone?: DayProgressTone;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Widget className={`metric-card ${className}`} aria-label={title}>
      <Widget.Header>
        <Widget.Title icon={icon}>
          <h2 className="font-medium">{title}</h2>
        </Widget.Title>
      </Widget.Header>
      <Widget.Content>
        <MetricValue value={value} unit={unit} target={progress?.goal.target} />
        <GoalMeter
          title={title}
          progress={progress}
          dayProgress={dayProgress}
          dayProgressTone={dayProgressTone}
        />
        {children}
      </Widget.Content>
    </Widget>
  );
}
