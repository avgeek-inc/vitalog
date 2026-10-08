"use client";
import { ErrorPage } from "@avgeek-oss/design-system/patterns/feedback/error-page";
export default function Error({ retry }: { retry: () => void }) {
  return (
    <ErrorPage
      status="server-error"
      title="We couldn't load your records"
      onRetry={retry}
      returnHref="/daily"
      returnLabel="Go to Daily View"
    />
  );
}
