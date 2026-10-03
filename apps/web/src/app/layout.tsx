import type { Metadata } from "next";
import { headers } from "next/headers";
import { Providers } from "../components/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Vitalog", template: "%s · Vitalog" },
  description: "Connect to your personal health ledger.",
  applicationName: "Vitalog",
  authors: [{ name: "Avgeek, Inc." }],
  robots: { index: false, follow: false },
  icons: {
    icon: "/brand/vitalog-favicon.png",
    apple: "/brand/vitalog-touch-icon.png",
  },
};

export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html:
              "document.documentElement.classList.add(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')",
          }}
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
