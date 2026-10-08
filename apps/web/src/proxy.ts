import { NextResponse, type NextRequest } from "next/server";
import { webConfiguration } from "./lib/config";

export function proxy(request: NextRequest) {
  const { apiBaseUrl, uiBaseUrl } = webConfiguration();
  if (request.headers.get("host") !== new URL(uiBaseUrl).host)
    return new NextResponse("Host is not permitted", { status: 403 });
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: https://www.gravatar.com",
    `connect-src 'self' ${apiBaseUrl}`,
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join("; ");
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export const config = {
  matcher: [
    "/",
    "/login",
    "/daily",
    "/weight",
    "/settings/:path*",
    "/auth/:path*",
    "/api-keys",
    "/oauth/authorize",
  ],
};
