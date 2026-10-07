import type { Metadata } from "next";
import { Page } from "@avgeek-oss/design-system/layouts/page";
import { AppShellBreadcrumb } from "@avgeek-oss/design-system/layouts/app-shell-breadcrumb";
import { Suspense } from "react";
import { DailyView } from "../../../components/daily-view";
import { DashboardSkeleton } from "../../../components/dashboard-skeleton";
import { DayNavigation } from "../../../components/day-navigation";
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
    <Page>
      <AppShellBreadcrumb
        items={[{ label: "Stats" }, { label: "Daily View" }]}
        title="Daily View"
      />
      <div className="py-5">
        <DayNavigation date={date} today={session.today} />
      </div>
      <Suspense key={date} fallback={<DashboardSkeleton view="daily" />}>
        <DailyData date={date} timezone={session.timezone} />
      </Suspense>
    </Page>
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
