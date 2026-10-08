"use client";
import { ApplicationPage } from "@avgeek-oss/design-system/patterns/pages/page";
import { HugeiconsIcon } from "@hugeicons/react";
import Calendar01Icon from "@hugeicons/core-free-icons/Calendar01Icon";
import { useEffect, useState } from "react";
import { DailyView } from "./daily-view";
import { DashboardSkeleton } from "./dashboard-skeleton";
import { DayNavigation } from "./day-navigation";
import { useSession } from "./dashboard-session";
import { readDaily, selectedDate } from "../lib/read-health";
import { BackendRecovery } from "./backend-recovery";

type DailyData = Awaited<ReturnType<typeof readDaily>>;
export function DailyScreen({
  requestedDate,
}: {
  requestedDate?: string | string[];
}) {
  const session = useSession();
  const [data, setData] = useState<DailyData>();
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const date = selectedDate(requestedDate, session.today);
  useEffect(() => {
    let active = true;
    setData(undefined);
    setError(false);
    readDaily(date).then(
      (value) => {
        if (active) setData(value);
      },
      () => {
        if (active) setError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [date, session.timezone, attempt]);
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
      {error ? (
        <BackendRecovery retry={() => setAttempt((value) => value + 1)} />
      ) : data ? (
        <DailyView date={date} timezone={session.timezone} {...data} />
      ) : (
        <DashboardSkeleton view="daily" />
      )}
    </ApplicationPage>
  );
}
