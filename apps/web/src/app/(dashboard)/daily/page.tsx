import type { Metadata } from "next";
import { ApplicationPage } from "@avgeek-oss/design-system/patterns/pages/page";
import { HugeiconsIcon } from "@hugeicons/react";
import Calendar01Icon from "@hugeicons/core-free-icons/Calendar01Icon";
import { Suspense } from "react";
import { DailyView } from "../../../components/daily-view";
import { DashboardSkeleton } from "../../../components/dashboard-skeleton";
import { DayNavigation } from "../../../components/day-navigation";
import { readDaily, selectedDate } from "../../../lib/read-health";
import { requireSession } from "../../../lib/session";
export const metadata: Metadata = { title: "Daily View" };
export default async function Daily({
  searchParams,
}: {
  searchParams: Promise<{ date?: string | string[] }>;
}) {
  const session = await requireSession();
  const date = selectedDate((await searchParams).date, session.today);
  return (
    <ApplicationPage
      title="Daily View"
      titleContent={
        <span className="inline-flex min-w-0 items-center gap-2">
          <HugeiconsIcon
            icon={Calendar01Icon}
            size={24}
            className="shrink-0"
            aria-hidden
          />
          Daily View
        </span>
      }
      breadcrumbAncestors={[]}
    >
      <div className="pb-5">
        <DayNavigation date={date} today={session.today} />
      </div>
      <Suspense key={date} fallback={<DashboardSkeleton view="daily" />}>
        <DailyData date={date} timezone={session.timezone} />
      </Suspense>
    </ApplicationPage>
  );
}
async function DailyData({
  date,
  timezone,
}: {
  date: string;
  timezone: string;
}) {
  const data = await readDaily(date);
  return <DailyView date={date} timezone={timezone} {...data} />;
}
