import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { serverApiBaseUrl, webConfiguration } from "./config";

import type { Account } from "../../../../src/auth/account-contracts";
export type Session = {
  account: Account;
  expires_at: string;
  timezone: string;
  today: string;
};
export function sessionCookieName() {
  return webConfiguration().uiBaseUrl.startsWith("https:")
    ? "__Host-vitalog-session"
    : "vitalog-session";
}
export async function sessionToken() {
  const token = (await cookies()).get(sessionCookieName())?.value;
  return token && /^vls_[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}
export async function apiRequest(
  path: string,
  token: string,
  init?: RequestInit,
) {
  return fetch(serverApiBaseUrl() + path, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${token}` },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
}
export const requireSession = cache(async () => {
  const token = await sessionToken();
  if (!token) redirect("/login");
  const response = await apiRequest("/auth/session", token);
  if (response.status === 401) redirect("/login");
  if (!response.ok) throw new Error("Health data is unavailable");
  const session: Session = await response.json();
  return { token, ...session };
});
export function permitsBrowserRequest(request: Request) {
  return (
    request.headers.get("origin") === webConfiguration().uiBaseUrl &&
    !new URL(request.url).search
  );
}
