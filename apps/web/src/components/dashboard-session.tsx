"use client";

import { usePathname, useSearchParams } from "next/navigation";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { Account } from "../../../../src/auth/account-contracts";
import { apiFetch } from "../lib/browser-api";
import { BackendRecovery } from "./backend-recovery";
import { DashboardSkeleton } from "./dashboard-skeleton";
import { DashboardShell } from "./dashboard-shell";

export type Session = {
  account: Account;
  expires_at: string;
  timezone: string;
  today: string;
};
const SessionContext = createContext<Session | null>(null);

export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error("Dashboard session is required");
  return session;
}

export function DashboardSession({
  children,
  docsUrl,
}: {
  children: ReactNode;
  docsUrl: string;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const route = `${pathname}?${searchParams}`;
  const [snapshot, setSnapshot] = useState<{
    route: string;
    session: Session;
  }>();
  const [failedRoute, setFailedRoute] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    apiFetch("/auth/session", { signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) {
          window.location.replace("/login");
          return;
        }
        if (!response.ok) throw new Error("Session is unavailable");
        const session: Session = await response.json();
        if (!controller.signal.aborted) {
          setSnapshot({ route, session });
          setFailedRoute(undefined);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailedRoute(route);
      });
    return () => controller.abort();
  }, [route, attempt]);
  if (failedRoute === route)
    return (
      <BackendRecovery
        retry={() => {
          setFailedRoute(undefined);
          setAttempt((value) => value + 1);
        }}
      />
    );
  if (!snapshot) return <DashboardSkeleton view="daily" />;
  const { session } = snapshot;
  return (
    <SessionContext.Provider value={session}>
      <DashboardShell account={session.account} docsUrl={docsUrl}>
        {snapshot.route === route ? (
          children
        ) : (
          <DashboardSkeleton view="daily" />
        )}
      </DashboardShell>
    </SessionContext.Provider>
  );
}
