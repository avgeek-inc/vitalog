"use client";
import { ApplicationPage } from "@avgeek-oss/design-system/patterns/pages/page";
import { HugeiconsIcon } from "@hugeicons/react";
import WeightScaleIcon from "@hugeicons/core-free-icons/WeightScaleIcon";
import { useEffect, useState } from "react";
import { DashboardSkeleton } from "./dashboard-skeleton";
import { WeightView } from "./weight-view";
import { useSession } from "./dashboard-session";
import { readHealth, readRecords } from "../lib/read-health";
import type { GoalProgress, HealthRecord } from "../lib/health";
import { recordCalendarDate } from "../../../../src/domain/record-date";
import { BackendRecovery } from "./backend-recovery";

export function WeightScreen() {
  const { today, timezone } = useSession();
  const [data, setData] = useState<{
    records: HealthRecord[];
    goals: GoalProgress[];
  }>();
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setData(undefined);
    setError(false);
    Promise.all([
      readRecords(
        {
          record_types: "measurement",
          metric_key: "weight",
          end_date: today,
          include_undated: "true",
        },
        10000,
      ),
      readHealth<{ progress: GoalProgress[] }>(
        `/v1/days/${today}/goal-progress`,
      ),
    ]).then(
      ([records, goals]) => {
        if (active)
          setData({
            records: records.map((record) => ({
              ...record,
              occurred_on: recordCalendarDate(record, timezone),
            })),
            goals: goals.progress,
          });
      },
      () => {
        if (active) setError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [today, timezone, attempt]);
  return (
    <ApplicationPage
      title="Weight Management"
      titleContent={
        <span className="inline-flex min-w-0 items-center gap-2">
          <HugeiconsIcon
            icon={WeightScaleIcon}
            size={24}
            className="shrink-0"
            aria-hidden
          />
          Weight Management
        </span>
      }
      breadcrumbAncestors={[]}
    >
      {error ? (
        <BackendRecovery retry={() => setAttempt((value) => value + 1)} />
      ) : data ? (
        <WeightView
          records={data.records}
          today={today}
          progress={data.goals.find(
            (progress) => progress.goal.metric === "measurement:weight",
          )}
        />
      ) : (
        <DashboardSkeleton view="weight" />
      )}
    </ApplicationPage>
  );
}
