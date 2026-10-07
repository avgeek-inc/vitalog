import type { Metadata } from "next";
import { ApplicationPage } from "@avgeek-oss/design-system/patterns/pages/page";
import { HugeiconsIcon } from "@hugeicons/react";
import WeightScaleIcon from "@hugeicons/core-free-icons/WeightScaleIcon";
import { Suspense } from "react";
import { DashboardSkeleton } from "../../../components/dashboard-skeleton";
import { WeightView } from "../../../components/weight-view";
import { readHealth, readRecords } from "../../../lib/read-health";
import { requireSession } from "../../../lib/session";
import type { GoalProgress } from "../../../lib/health";
export const metadata: Metadata = { title: "Weight Management" };
export default async function Weight() {
  const { today } = await requireSession();
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
      <Suspense fallback={<DashboardSkeleton view="weight" />}>
        <WeightData today={today} />
      </Suspense>
    </ApplicationPage>
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
