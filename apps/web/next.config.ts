import type { NextConfig } from "next";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../..",
  ),
  poweredByHeader: false,
  agentRules: false,
  allowedDevOrigins: ["localhost", "127.0.0.1"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
};

export default nextConfig;
