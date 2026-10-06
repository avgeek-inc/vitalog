import type { Metadata } from "next";
import { Suspense } from "react";
import { DashboardSkeleton } from "../../../components/dashboard-skeleton";
import { WeightView } from "../../../components/weight-view";
import { readHealth, readRecords } from "../../../lib/read-health";
import { requireSession } from "../../../lib/session";
import type { GoalProgress } from "../../../lib/health";
export const metadata: Metadata = { title: "Weight" };
export default async function Weight() {
  const { today } = await requireSession();
  return (
    <>
      <div className="page-heading">
        <h1>Weight</h1>
      </div>
      <Suspense fallback={<DashboardSkeleton view="weight" />}>
        <WeightData today={today} />
      </Suspense>
    </>
  );
}
async function WeightData({ today }: { today: string }) {
  const [records, goals] = await Promise.all([
    readRecords(
      {
        record_types: "measurement",
        metric_key: "weight",
        end_date: today,
        include_undated: "true",
      },
      10000,
    ),
    readHealth<{ progress: GoalProgress[] }>(`/v1/days/${today}/goal-progress`),
  ]);
  return (
    <WeightView
      records={records}
      today={today}
      progress={goals.progress.find(
        (progress) => progress.goal.metric === "measurement:weight",
      )}
    />
  );
}
