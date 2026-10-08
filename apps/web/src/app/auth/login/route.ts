import { NextResponse } from "next/server";
import { serverApiBaseUrl, webConfiguration } from "../../../lib/config";
import { permitsBrowserRequest, sessionCookieName } from "../../../lib/session";

export async function POST(request: Request) {
  if (!permitsBrowserRequest(request))
    return NextResponse.json({}, { status: 403 });
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get("content-type") ?? "",
    )
  )
    return NextResponse.json({}, { status: 422 });
  const reader = request.body?.getReader();
  if (!reader) return NextResponse.json({}, { status: 422 });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 4096) {
      await reader.cancel();
      return NextResponse.json({}, { status: 413 });
    }
    chunks.push(value);
  }
  let input: unknown;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return NextResponse.json({}, { status: 422 });
  }
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !["email", "password"].includes(key)) ||
    !("email" in input) ||
    typeof input.email !== "string" ||
    input.email.length > 254 ||
    !("password" in input) ||
    typeof input.password !== "string" ||
    Buffer.byteLength(input.password) > 256
  )
    return NextResponse.json({}, { status: 422 });
  const { uiBaseUrl } = webConfiguration();
  try {
    const response = await fetch(serverApiBaseUrl() + "/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: uiBaseUrl },
      body: JSON.stringify(input),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return NextResponse.json({}, { status: response.status });
    const data: { session_token: string; expires_at: string } =
      await response.json();
    const expires = new Date(data.expires_at);
    if (
      !/^vls_[A-Za-z0-9_-]{43}$/.test(data.session_token) ||
      !Number.isFinite(expires.getTime()) ||
      expires.getTime() <= Date.now() ||
      expires.getTime() > Date.now() + 31 * 86_400_000
    )
      return NextResponse.json({}, { status: 502 });
    const result = NextResponse.json({ signed_in: true });
    result.cookies.set(sessionCookieName(), data.session_token, {
      httpOnly: true,
      secure: uiBaseUrl.startsWith("https:"),
      sameSite: "lax",
      path: "/",
      expires,
    });
    return result;
  } catch {
    return NextResponse.json({}, { status: 503 });
  }
}
