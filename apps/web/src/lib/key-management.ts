import "server-only";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { webConfiguration } from "./config";
import { apiRequest, permitsBrowserRequest, sessionToken } from "./session";

export function keyManagementCookieName() {
  return webConfiguration().uiBaseUrl.startsWith("https:")
    ? "__Host-vitalog-key-management"
    : "vitalog-key-management";
}
export async function keyManagementToken() {
  const value = (await cookies()).get(keyManagementCookieName())?.value;
  return value && /^vlm_[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}
export async function keyManagementProxy(request: Request, path: string) {
  const url = new URL(request.url);
  if (request.method === "GET") {
    if (
      request.headers.get("sec-fetch-site") === "cross-site" ||
      (request.headers.has("origin") &&
        request.headers.get("origin") !== webConfiguration().uiBaseUrl)
    )
      return NextResponse.json({}, { status: 403 });
  } else {
    const scopedRevocation =
      request.method === "DELETE" &&
      path === "api-keys" &&
      url.searchParams.size === 1 &&
      ["api-key", "mcp"].includes(url.searchParams.get("kind") ?? "") &&
      request.headers.get("origin") === webConfiguration().uiBaseUrl;
    if (!permitsBrowserRequest(request) && !scopedRevocation)
      return NextResponse.json({}, { status: 403 });
    if (request.headers.has("content-type"))
      return NextResponse.json({}, { status: 422 });
    const reader = request.body?.getReader();
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.byteLength) {
          await reader.cancel();
          return NextResponse.json({}, { status: 422 });
        }
      }
    }
  }
  const browser = await sessionToken();
  const management = await keyManagementToken();
  if (!browser || (request.method !== "GET" && !management))
    return NextResponse.json({}, { status: 401 });
  try {
    const session = await apiRequest("/auth/session", browser);
    if (!session.ok)
      return NextResponse.json(
        {},
        { status: session.status === 401 ? 401 : 503 },
      );
    const response = await apiRequest(
      "/auth/key-management/" +
        path +
        (request.method === "GET" ||
        (request.method === "DELETE" && path === "api-keys")
          ? url.search
          : ""),
      request.method === "GET" ? browser : management!,
      {
        method: request.method,
        headers: { Origin: webConfiguration().uiBaseUrl },
      },
    );
    if (!response.ok) return NextResponse.json({}, { status: response.status });
    return NextResponse.json(await response.json(), {
      status: response.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({}, { status: 503 });
  }
}
