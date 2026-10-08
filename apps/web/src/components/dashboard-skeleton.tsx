"use client";

import {
  LoadingSkeleton,
  SkeletonCard,
} from "@avgeek-oss/design-system/patterns/feedback/loading-skeleton";

export function DashboardSkeleton({ view }: { view: "daily" | "weight" }) {
  return (
    <LoadingSkeleton
      className="dashboard-loading"
      aria-label="Loading health data"
    >
      {view === "daily" ? (
        <div className="daily-layout">
          <div className="loading-summary">
            <SkeletonCard className="loading-nutrition" />
            <div className="loading-metrics">
              {[1, 2, 3, 4].map((key) => (
                <SkeletonCard className="loading-card" key={key} />
              ))}
            </div>
          </div>
          <SkeletonCard className="loading-logs" />
        </div>
      ) : (
        <div className="weight-layout">
          <div className="weight-grid">
            <SkeletonCard className="loading-weight" />
            <SkeletonCard className="loading-chart" />
          </div>
          <SkeletonCard className="loading-logs" />
        </div>
      )}
    </LoadingSkeleton>
  );
}
