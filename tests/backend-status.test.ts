import { afterEach, expect, test, vi } from "vitest";

const { sessionToken } = vi.hoisted(() => ({
  sessionToken: vi.fn<() => Promise<string | null>>(),
}));
vi.mock("../apps/web/src/lib/session", () => ({ sessionToken }));
vi.mock("../apps/web/src/lib/config", () => ({
  serverApiBaseUrl: () => "http://backend.test",
}));
const { GET } = await vi.importActual<{
  GET: (request: Request) => Promise<Response>;
}>("../apps/web/src/app/auth/backend-status/route");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

test("recovery checks the real backend session, without exposing its token", async () => {
  vi.mocked(sessionToken).mockResolvedValue("private-session-token");
  const fetcher = vi
    .fn()
    .mockResolvedValue(Response.json({ account: { id: "private" } }));
  vi.stubGlobal("fetch", fetcher);
  const response = await GET(
    new Request("http://web.test/auth/backend-status"),
  );
  expect(fetcher.mock.calls[0]?.[0]).toBe("http://backend.test/auth/session");
  expect(fetcher.mock.calls[0]?.[1].headers.Authorization).toBe(
    "Bearer private-session-token",
  );
  expect(await response.json()).toEqual({ available: true });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});

test.each([401, 403, 404])(
  "HTTP %s is reachable rather than a backend outage",
  async (status) => {
    vi.mocked(sessionToken).mockResolvedValue("expired-token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status })),
    );
    const response = await GET(
      new Request("http://web.test/auth/backend-status"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ available: true });
  },
);

test.each(["network", "unavailable"])(
  "%s failure remains an outage",
  async (failure) => {
    vi.mocked(sessionToken).mockResolvedValue("session-token");
    const fetcher = vi.fn();
    if (failure === "network")
      fetcher.mockRejectedValue(new TypeError("fetch failed"));
    else fetcher.mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    const response = await GET(
      new Request("http://web.test/auth/backend-status"),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ available: false });
  },
);
