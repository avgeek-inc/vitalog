import { z } from "zod";

export const credentialsSchema = z.strictObject({
  email: z.string().trim().email().max(254),
  password: z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value) <= 256),
});
export const manualKeyCreation = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    access: z.enum(["read", "edit"]),
    includeAdmin: z.boolean(),
    expiresAt: z.iso.datetime().nullable(),
  })
  .refine((value) => !value.includeAdmin || value.access === "edit", {
    message: "Administrative permissions require Edit access",
    path: ["includeAdmin"],
  })
  .refine(
    (value) =>
      value.expiresAt === null || Date.parse(value.expiresAt) > Date.now(),
    {
      message: "Expiry must be in the future",
      path: ["expiresAt"],
    },
  );
export const keyCreation = credentialsSchema
  .extend(manualKeyCreation.shape)
  .refine((value) => !value.includeAdmin || value.access === "edit", {
    message: "Administrative permissions require Edit access",
    path: ["includeAdmin"],
  })
  .refine(
    (value) =>
      value.expiresAt === null || Date.parse(value.expiresAt) > Date.now(),
    {
      message: "Expiry must be in the future",
      path: ["expiresAt"],
    },
  );
export const keyMetadata = z.strictObject({
  id: z.uuid(),
  token_hint: z.string(),
  name: z.string().nullable(),
  access: z.enum(["read", "edit"]).nullable(),
  includeAdmin: z.boolean().nullable(),
  oauth_client_id: z.string().nullable().optional(),
  oauth_client_name: z.string().nullable().optional(),
  oauth_scopes: z.array(z.string()).nullable().optional(),
  created_at: z.iso.datetime(),
  expires_at: z.iso.datetime().nullable(),
  revoked_at: z.iso.datetime().nullable(),
  status: z.enum(["active", "expired", "revoked"]),
});
export const keyCreated = keyMetadata.extend({
  api_key: z
    .string()
    .regex(/^vlk_[A-Za-z0-9_-]{43}$/)
    .nullable(),
});
export const keyListQuery = z.strictObject({
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).max(1_000_000).default(0),
});
export const managedKeyListQuery = keyListQuery.extend({
  kind: z.enum(["api-key", "mcp"]).optional(),
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
      "Generate a personal API key using root credentials and required name, access, includeAdmin and expiresAt settings. Null expiry means Never. Read keys read health data; Edit keys also write it; Administrative permissions also allow operator readiness and OpenAPI inspection. Keys cannot manage credentials or account settings. The complete key is returned once.",
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
      "List generated API keys, OAuth connections and browser session metadata, including expiry and revocation status. Requires the environment AUTH_KEY; never returns keys, tokens or hashes.",
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
      "Revoke a generated API key, OAuth connection or browser session by ID. Already revoked records return their metadata. Requires the environment AUTH_KEY.",
    rootOnly: true,
    output: keyMetadata,
  },
  {
    name: "revoke_all_api_keys",
    method: "DELETE",
    path: "/v1/api-keys",
    status: "200",
    description:
      "Revoke all currently unrevoked generated API keys, OAuth connections and browser sessions, including expired records, and cancel pending authorization codes. The environment AUTH_KEY is unaffected.",
    rootOnly: true,
    output: keysRevoked,
  },
] as const;
