"use client";

import { useEffect, useState } from "react";
import { dayProgressPercent } from "../lib/day-progress";

export function useDayProgress(date: string, timezone: string) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const update = () => setNow(Date.now());
    update();
    const timer = window.setInterval(update, 60_000);
    const resume = () => {
      if (!document.hidden) update();
    };
    document.addEventListener("visibilitychange", resume);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", resume);
    };
  }, []);
  return now === null ? null : dayProgressPercent(date, timezone, now);
}
