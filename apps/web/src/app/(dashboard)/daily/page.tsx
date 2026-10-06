import type { Metadata } from "next";
import { ApplicationPage } from "@avgeek-oss/design-system/patterns/pages/page";
import { Suspense } from "react";
import { DailyView } from "../../../components/daily-view";
import { DashboardSkeleton } from "../../../components/dashboard-skeleton";
import { DayNavigation } from "../../../components/day-navigation";
import { dateLabel } from "../../../lib/health";
import { readDaily, selectedDate } from "../../../lib/read-health";
import { requireSession } from "../../../lib/session";
export const metadata: Metadata = { title: "Daily" };
export default async function Daily({
  searchParams,
}: {
  searchParams: Promise<{ date?: string | string[] }>;
}) {
  const session = await requireSession();
  const date = selectedDate((await searchParams).date, session.today);
  return (
    <ApplicationPage
      title={dateLabel(date)}
      breadcrumbAncestors={[{ label: "Stats" }]}
      breadcrumbLabel="Daily View"
      titleContent={
        <span className="daily-title">
          <span>{dateLabel(date)}</span>
          <DayNavigation date={date} today={session.today} />
        </span>
      }
    >
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
