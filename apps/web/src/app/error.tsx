"use client";
import { ErrorPage } from "@avgeek-oss/design-system/patterns/feedback/error-page";
export default function Error({ retry }: { retry: () => void }) {
  return (
    <ErrorPage
      status="unavailable"
      title="Vitalog is temporarily unavailable"
      onRetry={retry}
      returnHref="/daily"
      returnLabel="Go to Daily View"
    />
  );
}
