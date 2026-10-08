import { z } from "zod";
import {
  keyCreated,
  credentialsSchema,
  manualKeyCreation,
  keyList,
  managedKeyListQuery,
  keyMetadata,
  keysRevoked,
} from "./contracts.js";

export const keyManagementCreated = z.strictObject({
  session_token: z.string().regex(/^vlm_[A-Za-z0-9_-]{43}$/),
  expires_at: z.iso.datetime(),
});
const browserManagementCreated = z.union([
  keyManagementCreated,
  z.strictObject({ signed_in: z.literal(true) }),
]);
export const keyManagementOperations = [
  {
    name: "create_key_management_session",
    method: "POST",
    path: "/auth/key-management/session",
    status: "201",
    credentials: true,
    input: credentialsSchema,
    output: browserManagementCreated,
    description:
      "Verify root credentials and issue a revocable, 30-minute session for API-key management only. Requests from UI_BASE_URL receive a host-only HttpOnly API cookie; non-browser clients receive a Bearer token. This credential cannot read or write health data, access MCP, or use the primary AUTH_KEY administration routes.",
  },
  {
    name: "get_key_management_session",
    method: "GET",
    path: "/auth/key-management/session",
    status: "200",
    output: z.strictObject({ expires_at: z.iso.datetime() }),
    description:
      "Validate a key-management session and read its effective expiry. Requires a vlm_ Bearer token.",
  },
  {
    name: "revoke_key_management_session",
    method: "DELETE",
    path: "/auth/key-management/session",
    status: "200",
    output: z.strictObject({ signed_out: z.literal(true) }),
    description:
      "Revoke the authenticated key-management session. Accepts no body or query arguments.",
  },
  {
    name: "list_managed_api_keys",
    method: "GET",
    path: "/auth/key-management/api-keys",
    status: "200",
    input: managedKeyListQuery,
    output: keyList,
    description:
      "Using a browser or management session, list unrevoked API keys and MCP connections, filtering before pagination. Excludes dashboard and management sessions. Never returns tokens or hashes.",
  },
  {
    name: "create_managed_api_key",
    input: manualKeyCreation,
    method: "POST",
    path: "/auth/key-management/api-keys",
    status: "201",
    output: keyCreated,
    description:
      "Generate a personal API key using a verified management session with required name, access, includeAdmin and expiresAt settings. Null expiry means Never. Credential and account management remain browser/root-only. The complete key is returned once.",
  },
  {
    name: "revoke_managed_api_key",
    method: "DELETE",
    path: "/auth/key-management/api-keys/{id}",
    status: "200",
    output: keyMetadata,
    description:
      "Revoke one API key or MCP connection. Dashboard and management session IDs are rejected. Accepts no body or query arguments.",
  },
  {
    name: "revoke_all_managed_api_keys",
    method: "DELETE",
    path: "/auth/key-management/api-keys",
    status: "200",
    output: keysRevoked,
    description:
      "Revoke all API keys and MCP connections, including expired records, and cancel pending OAuth authorization codes. An optional kind filter revokes only manual keys or MCP connections. Dashboard and management sessions remain signed in. The environment AUTH_KEY is unaffected.",
  },
] as const;
