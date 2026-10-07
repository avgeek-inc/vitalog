import { ErrorPage } from "@avgeek-oss/design-system/patterns/feedback/error-page";
export default function NotFound() {
  return (
    <ErrorPage
      status="not-found"
      returnHref="/daily"
      returnLabel="Go to Daily View"
    />
  );
}
