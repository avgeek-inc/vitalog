import { z } from "zod";
import { keyCreation } from "./contracts.js";
export const sessionCreated = z.strictObject({
  session_token: z.string().regex(/^vls_[A-Za-z0-9_-]{43}$/),
  expires_at: z.iso.datetime(),
});
export const sessionInfo = z.strictObject({
  expires_at: z.iso.datetime(),
  timezone: z.string(),
  today: z.iso.date(),
});
export const sessionOperations = [
  {
    name: "create_browser_session",
    method: "POST",
    path: "/auth/session",
    status: "201",
    input: keyCreation,
    output: sessionCreated,
    description:
      "Create a revocable 30-day, read-only browser session using root credentials. The Next.js UI keeps this opaque token in a host-only HttpOnly cookie. It cannot write records or goals, manage keys, or access MCP.",
  },
  {
    name: "get_browser_session",
    method: "GET",
    path: "/auth/session",
    status: "200",
    output: sessionInfo,
    description:
      "Validate a browser session and read its expiry, server timezone and today's local date. Requires a vls_ Bearer token.",
  },
  {
    name: "revoke_browser_session",
    method: "DELETE",
    path: "/auth/session",
    status: "200",
    output: z.strictObject({ signed_out: z.literal(true) }),
    description:
      "Revoke the authenticated browser session. Accepts no body or query arguments. The environment AUTH_KEY can also revoke sessions through API-key management.",
  },
] as const;
