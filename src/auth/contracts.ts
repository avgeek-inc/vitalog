import { z } from "zod";

export const keyCreation = z.strictObject({
  email: z.string().trim().email().max(254),
  password: z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value) <= 256),
});
export const keyMetadata = z.strictObject({
  id: z.uuid(),
  token_hint: z.string(),
  created_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  revoked_at: z.iso.datetime().nullable(),
  status: z.enum(["active", "expired", "revoked"]),
});
export const keyCreated = keyMetadata.extend({
  api_key: z.string().regex(/^vlk_[A-Za-z0-9_-]{43}$/),
});
export const keyListQuery = z.strictObject({
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).max(1_000_000).default(0),
});
export const keyList = z.strictObject({
  api_keys: z.array(keyMetadata),
  total: z.number().int().nonnegative(),
  limit: z.number().int(),
  offset: z.number().int(),
});
export const keysRevoked = z.strictObject({
  revoked_count: z.number().int().nonnegative(),
});
export const keyId = z.uuid();

export const keyOperations = [
  {
    name: "create_api_key",
    method: "POST",
    path: "/auth/api-keys",
    status: "201",
    description:
      "Generate a 30-day API key using ROOT_EMAIL and ROOT_PASSWORD. The complete key is returned once; it cannot manage API keys.",
    rootOnly: false,
    input: keyCreation,
    output: keyCreated,
  },
  {
    name: "list_api_keys",
    method: "GET",
    path: "/v1/api-keys",
    status: "200",
    description:
      "List generated key metadata, including expiry and revocation status. Requires the environment AUTH_KEY; never returns keys or hashes.",
    rootOnly: true,
    input: keyListQuery,
    output: keyList,
  },
  {
    name: "revoke_api_key",
    method: "DELETE",
    path: "/v1/api-keys/{id}",
    status: "200",
    description:
      "Revoke a generated API key by ID. Already revoked keys return their metadata. Requires the environment AUTH_KEY.",
    rootOnly: true,
    output: keyMetadata,
  },
  {
    name: "revoke_all_api_keys",
    method: "DELETE",
    path: "/v1/api-keys",
    status: "200",
    description:
      "Revoke all currently unrevoked generated keys, including expired keys. The environment AUTH_KEY is unaffected.",
    rootOnly: true,
    output: keysRevoked,
  },
] as const;
