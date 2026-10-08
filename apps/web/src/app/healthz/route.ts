import { serverApiBaseUrl, webConfiguration } from "../../lib/config";

export const dynamic = "force-dynamic";

export function GET() {
  try {
    webConfiguration();
    serverApiBaseUrl();
    return Response.json(
      { status: "ok" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { status: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
