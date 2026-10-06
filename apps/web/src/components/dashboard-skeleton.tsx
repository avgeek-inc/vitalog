"use client";

import { Card, Skeleton } from "@heroui/react";

function LoadingCard({ className }: { className: string }) {
  return (
    <Card className={`loading-surface ${className}`}>
      <Skeleton className="loading-fill" />
    </Card>
  );
}

export function DashboardSkeleton({ view }: { view: "daily" | "weight" }) {
  return (
    <div
      className="dashboard-loading"
      role="status"
      aria-label="Loading health data"
    >
      {view === "daily" ? (
        <div className="daily-layout">
          <div className="loading-summary">
            <LoadingCard className="loading-nutrition" />
            <div className="loading-metrics">
              {[1, 2, 3, 4].map((key) => (
                <LoadingCard className="loading-card" key={key} />
              ))}
            </div>
          </div>
          <LoadingCard className="loading-logs" />
        </div>
      ) : (
        <div className="weight-layout">
          <div className="weight-grid">
            <LoadingCard className="loading-weight" />
            <LoadingCard className="loading-chart" />
          </div>
          <LoadingCard className="loading-logs" />
        </div>
      )}
    </div>
  );
}
