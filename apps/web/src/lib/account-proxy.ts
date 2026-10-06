import "server-only";
import { NextResponse } from "next/server";
import { apiRequest, permitsBrowserRequest, sessionToken } from "./session";
import { webConfiguration } from "./config";
export async function accountProxy(request: Request, path: string) {
  if (!permitsBrowserRequest(request))
    return NextResponse.json({}, { status: 403 });
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get("content-type") ?? "",
    )
  )
    return NextResponse.json({}, { status: 422 });
  const token = await sessionToken();
  if (!token) return NextResponse.json({}, { status: 401 });
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader)
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
  try {
    const response = await apiRequest(path, token, {
      method: request.method,
      headers: {
        "Content-Type": "application/json",
        Origin: webConfiguration().uiBaseUrl,
      },
      body: Buffer.concat(chunks),
    });
    if (!response.ok) return NextResponse.json({}, { status: response.status });
    return NextResponse.json(await response.json(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({}, { status: 503 });
  }
}
