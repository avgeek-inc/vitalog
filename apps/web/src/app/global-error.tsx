"use client";
import "./globals.css";
import { themeBootstrapScript } from "@avgeek-oss/design-system/lib/theme";
import { ErrorPage } from "@avgeek-oss/design-system/patterns/feedback/error-page";
export default function GlobalError({ retry }: { retry: () => void }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
      </head>
      <body>
        <ErrorPage
          status="server-error"
          onRetry={retry}
          returnHref="/daily"
          returnLabel="Go to Daily View"
        />
      </body>
    </html>
  );
}
