import { NextResponse } from "next/server";
import {
  keyManagementToken,
  keyManagementCookieName,
} from "../../../lib/key-management";
import {
  apiRequest,
  permitsBrowserRequest,
  sessionCookieName,
  sessionToken,
} from "../../../lib/session";
import { webConfiguration } from "../../../lib/config";

export async function POST(request: Request) {
  if (!permitsBrowserRequest(request))
    return NextResponse.json({}, { status: 403 });
  if ((await request.text()).length)
    return NextResponse.json({}, { status: 422 });
  const token = await sessionToken();
  let revoked = !token;
  if (token) {
    try {
      const response = await apiRequest("/auth/session", token, {
        method: "DELETE",
        headers: { Origin: webConfiguration().uiBaseUrl },
      });
      revoked = response.ok || response.status === 401;
    } catch {
      revoked = false;
    }
  }
  const management = await keyManagementToken();
  if (management) {
    try {
      const ended = await apiRequest(
        "/auth/key-management/session",
        management,
        { method: "DELETE", headers: { Origin: webConfiguration().uiBaseUrl } },
      );
      revoked = revoked && (ended.ok || ended.status === 401);
    } catch {
      revoked = false;
    }
  }
  const response = NextResponse.json({ signed_out: true, revoked });
  response.cookies.set(sessionCookieName(), "", {
    httpOnly: true,
    secure: webConfiguration().uiBaseUrl.startsWith("https:"),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  response.cookies.set(keyManagementCookieName(), "", {
    httpOnly: true,
    secure: webConfiguration().uiBaseUrl.startsWith("https:"),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
