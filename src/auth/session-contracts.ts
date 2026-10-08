import { z } from "zod";
import { accountSchema } from "./account-contracts.js";
import { credentialsSchema } from "./contracts.js";
export const sessionCreated = z.strictObject({
  session_token: z.string().regex(/^vls_[A-Za-z0-9_-]{43}$/),
  expires_at: z.iso.datetime(),
});
const browserSessionCreated = z.union([
  sessionCreated,
  z.strictObject({ signed_in: z.literal(true) }),
]);
export const sessionInfo = z.strictObject({
  expires_at: z.iso.datetime(),
  timezone: z.string(),
  today: z.iso.date(),
  account: accountSchema,
});
export const sessionOperations = [
  {
    name: "create_browser_session",
    method: "POST",
    path: "/auth/session",
    status: "201",
    input: credentialsSchema,
    output: browserSessionCreated,
    description:
      "Create a revocable 30-day read-only session using root credentials. Requests from UI_BASE_URL receive a host-only HttpOnly API cookie and signed_in response; non-browser clients receive an opaque Bearer token. It cannot write records or goals, manage keys, or access MCP.",
  },
  {
    name: "get_browser_session",
    method: "GET",
    path: "/auth/session",
    status: "200",
    output: sessionInfo,
    description:
      "Validate a browser session and read its expiry, account timezone and today's local date. Accepts a vls_ Bearer token or the API cookie from UI_BASE_URL.",
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
