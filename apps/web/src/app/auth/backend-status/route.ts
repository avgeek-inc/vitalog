import { serverApiBaseUrl } from "../../../lib/config";
import { sessionToken } from "../../../lib/session";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  try {
    const token = await sessionToken();
    const response = await fetch(
      serverApiBaseUrl() + (token ? "/auth/session" : "/healthz"),
      {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]),
      },
    );
    // Authentication and validation failures are reachable responses, not outages.
    const available = response.status < 500;
    return Response.json(
      { available },
      { status: available ? 200 : 503, headers },
    );
  } catch {
    return Response.json({ available: false }, { status: 503, headers });
  }
}
