"use client";

import { useEffect, useState } from "react";
import {
  BackendUnavailable,
  useBackendReconnect,
} from "@avgeek-oss/design-system/patterns/feedback/backend-unavailable";
import { ErrorPage } from "@avgeek-oss/design-system/patterns/feedback/error-page";
import { QueryLoading } from "@avgeek-oss/design-system/patterns/feedback/query-state";
import { apiFetch } from "../lib/browser-api";

async function backendAvailable(signal: AbortSignal) {
  const response = await apiFetch("/healthz", {
    cache: "no-store",
    signal,
  });
  return response.ok;
}

export function BackendRecovery({ retry }: { retry: () => void }) {
  const [state, setState] = useState<"checking" | "unavailable" | "available">(
    "checking",
  );
  useEffect(() => {
    const controller = new AbortController();
    void backendAvailable(
      AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    ).then(
      (available) => {
        if (!controller.signal.aborted)
          setState(available ? "available" : "unavailable");
      },
      () => {
        if (!controller.signal.aborted) setState("unavailable");
      },
    );
    return () => controller.abort();
  }, []);
  useBackendReconnect(state === "unavailable", async (signal) => {
    const available = await backendAvailable(signal);
    if (!available || signal.aborted) return false;
    setState("available");
    retry();
    return true;
  });
  if (state === "checking") return <QueryLoading />;
  if (state === "unavailable") return <BackendUnavailable appName="Vitalog" />;
  return (
    <ErrorPage
      status="server-error"
      onRetry={retry}
      returnHref="/daily"
      returnLabel="Go to Daily View"
    />
  );
}
