import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { oauthClients } from "../db/schema.js";
import type { CredentialGuard } from "../security.js";
import { OAuthError } from "./oauth-error.js";
import {
  publicJwks,
  signingAlgorithms,
  verifyClientAssertion,
} from "./oauth-assertions.js";
import type { JSONWebKeySet } from "jose";

export const oauthScopes = ["health:read", "health:write"] as const;
const opaqueString = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\s\u0000-\u001f\u007f]+$/);
export const clientId = opaqueString;
const name = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]+$/);
const loopbackHosts = ["127.0.0.1", "[::1]", "localhost"];
export function validRedirectUri(value: string) {
  try {
    const uri = new URL(value);
    if (uri.username || uri.password || uri.hash || uri.href.includes("#"))
      return false;
    if (
      [
        "code",
        "state",
        "iss",
        "error",
        "error_description",
        "access_token",
      ].some((key) => uri.searchParams.has(key))
    )
      return false;
    if (uri.protocol === "https:") return !!uri.hostname;
    if (uri.protocol === "http:") return loopbackHosts.includes(uri.hostname);
    return /^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+:\/[^/]/.test(value) && !uri.host;
  } catch {
    return false;
  }
}
export const redirectUri = opaqueString.refine(
  validRedirectUri,
  "Use HTTPS, loopback HTTP or a reverse-domain native callback",
);
export function redirectMatches(registered: string, supplied: string) {
  if (registered === supplied) return true;
  const stripLoopbackPort = (value: string) =>
    value.replace(
      /^(http:\/\/(?:127\.0\.0\.1|\[::1\]))(?::\d+)?(?=\/|\?|$)/,
      "$1",
    );
  return (
    /^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::\d+)?\//.test(registered) &&
    validRedirectUri(supplied) &&
    stripLoopbackPort(registered) === stripLoopbackPort(supplied)
  );
}
export function parseScopes(value: string | undefined) {
  const scopes = value === undefined ? [...oauthScopes] : value.split(" ");
  if (
    !scopes.length ||
    scopes.length > 2 ||
    new Set(scopes).size !== scopes.length ||
    scopes.some(
      (scope) => !oauthScopes.includes(scope as (typeof oauthScopes)[number]),
    )
  )
    throw new OAuthError(
      "invalid_scope",
      "Use health:read and/or health:write",
    );
  return scopes;
}
const scope = z
  .string()
  .max(128)
  .refine((value) => {
    try {
      parseScopes(value);
      return true;
    } catch {
      return false;
    }
  });
const methods = z.enum([
  "none",
  "client_secret_basic",
  "client_secret_post",
  "private_key_jwt",
]);
function validateKeySource(
  client: {
    token_endpoint_auth_method: string;
    jwks?: unknown;
    jwks_uri?: string;
    token_endpoint_auth_signing_alg?: string;
  },
  context: z.RefinementCtx,
) {
  if (
    client.token_endpoint_auth_method === "private_key_jwt"
      ? !!client.jwks === !!client.jwks_uri
      : !!client.jwks ||
        !!client.jwks_uri ||
        !!client.token_endpoint_auth_signing_alg
  )
    context.addIssue({
      code: "custom",
      message: "JWT clients require exactly one public JWKS source",
    });
}
const metadata = z
  .object({
    client_name: name.default("MCP client"),
    redirect_uris: z
      .array(redirectUri)
      .min(1)
      .max(10)
      .refine((values) => new Set(values).size === values.length),
    token_endpoint_auth_method: methods.default("client_secret_basic"),
    grant_types: z
      .array(z.literal("authorization_code"))
      .length(1)
      .default(["authorization_code"]),
    response_types: z.array(z.literal("code")).length(1).default(["code"]),
    scope: scope.default(oauthScopes.join(" ")),
    jwks_uri: opaqueString
      .refine((value) => {
        try {
          metadataUrl(value);
          return true;
        } catch {
          return false;
        }
      })
      .optional(),
    jwks: publicJwks.optional(),
    token_endpoint_auth_signing_alg: z.enum(signingAlgorithms).optional(),
  })
  .superRefine(validateKeySource);
export const registrationSchema = metadata;
export type ClientMetadata = z.infer<typeof metadata>;
export type OAuthClient = ClientMetadata & {
  client_id: string;
  clientSecretDigest?: string;
};
const secret = z.string().regex(/^[A-Za-z0-9._~+/=-]{43,512}$/);
const configuredSchema = metadata
  .safeExtend({
    client_id: clientId,
    token_endpoint_auth_method: methods.default("none"),
    client_secret: secret.optional(),
  })
  .superRefine((client, context) => {
    if (
      ["client_secret_basic", "client_secret_post"].includes(
        client.token_endpoint_auth_method,
      ) !== !!client.client_secret
    )
      context.addIssue({
        code: "custom",
        message:
          "Confidential clients require a secret; public clients must not supply one",
      });
  });
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function configuredOAuthClients(value: string | undefined) {
  if (!value) return { clients: [] as OAuthClient[], secrets: [] as string[] };
  try {
    if (Buffer.byteLength(value) > 65536) throw new Error("Too large");
    const parsed = z.array(configuredSchema).max(20).parse(JSON.parse(value));
    if (
      new Set(parsed.map((client) => client.client_id)).size !== parsed.length
    )
      throw new Error("Duplicate client");
    return {
      clients: parsed.map(({ client_secret, ...client }) => ({
        ...client,
        ...(client_secret ? { clientSecretDigest: digest(client_secret) } : {}),
      })),
      secrets: parsed.flatMap((client) =>
        client.client_secret ? [client.client_secret] : [],
      ),
    };
  } catch {
    throw new Error(
      "OAUTH_CLIENTS must be a JSON array of unique client IDs, names, valid callbacks and supported client authentication",
    );
  }
}

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  blocked.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
export function publicAddress(address: string) {
  const family = isIP(address);
  return family === 4
    ? !blocked.check(address, "ipv4")
    : family === 6 &&
        globalV6.check(address, "ipv6") &&
        !blocked.check(address, "ipv6");
}
export function metadataUrl(value: string) {
  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    throw new OAuthError(
      "invalid_client",
      "Use a public HTTPS client metadata document with a path",
    );
  }
  const rawPath =
    value.replace(/^https:\/\/[^/?#]+/i, "").split(/[?#]/)[0] ?? "";
  if (
    !/^https:\/\//i.test(value) ||
    value.includes("\\") ||
    uri.protocol !== "https:" ||
    uri.username ||
    uri.password ||
    uri.hash ||
    value.includes("#") ||
    !rawPath ||
    rawPath.split("/").some((part) => /^(?:\.|%2e){1,2}$/i.test(part)) ||
    loopbackHosts.includes(uri.hostname) ||
    uri.hostname.endsWith(".localhost") ||
    (isIP(uri.hostname.replace(/^\[|\]$/g, "")) &&
      !publicAddress(uri.hostname.replace(/^\[|\]$/g, "")))
  )
    throw new OAuthError(
      "invalid_client",
      "Use a public HTTPS client metadata document with a path",
    );
  return uri;
}
export type ClientMetadataDocument = {
  body: string;
  cacheControl?: string;
  age?: string;
  expires?: string;
};
export type ClientMetadataFetcher = (
  clientId: string,
) => Promise<ClientMetadataDocument>;
export type MetadataNetwork = {
  lookup: typeof lookup;
  request: typeof request;
};
export async function fetchClientMetadata(
  clientId: string,
  network: MetadataNetwork = { lookup, request },
): Promise<ClientMetadataDocument> {
  const uri = metadataUrl(clientId);
  const signal = AbortSignal.timeout(5000);
  const addresses = await Promise.race([
    network.lookup(uri.hostname.replace(/^\[|\]$/g, ""), {
      all: true,
      verbatim: true,
    }),
    new Promise<never>((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      }),
    ),
  ]);
  if (
    !addresses.length ||
    addresses.some(({ address }) => !publicAddress(address))
  )
    throw new OAuthError(
      "invalid_client",
      "Client metadata must resolve only to public addresses",
    );
  const pinned = addresses.find((value) => value.family === 4) ?? addresses[0]!;
  return new Promise((resolve, reject) => {
    const outgoing = network.request(
      uri,
      {
        agent: false,
        signal,
        family: pinned.family,
        lookup: (_hostname, _options, callback) =>
          callback(null, pinned.address, pinned.family),
        headers: { Accept: "application/json", "Accept-Encoding": "identity" },
      },
      (incoming) => {
        if (
          incoming.statusCode !== 200 ||
          !/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(
            String(incoming.headers["content-type"] ?? ""),
          )
        ) {
          incoming.destroy();
          reject(
            new OAuthError(
              "invalid_client",
              "Client metadata must return a JSON document without redirects",
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        incoming.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 5120) {
            incoming.destroy(
              new OAuthError("invalid_client", "Client metadata exceeds 5 KiB"),
            );
            return;
          }
          chunks.push(chunk);
        });
        incoming.on("error", reject);
        incoming.on("end", () =>
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            cacheControl: incoming.headers["cache-control"],
            age: incoming.headers.age,
            expires: incoming.headers.expires,
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}
function cacheLifetime(document: ClientMetadataDocument) {
  const control = document.cacheControl ?? "";
  if (/\b(?:no-store|no-cache)\b/i.test(control)) return 0;
  const maximum = control.match(/(?:^|,)\s*max-age\s*=\s*"?(\d+)"?/i);
  const lifetime = maximum
    ? Number(maximum[1]) * 1000 - Number(document.age ?? 0) * 1000
    : document.expires
      ? Date.parse(document.expires) - Date.now()
      : 300_000;
  return Number.isFinite(lifetime)
    ? Math.max(0, Math.min(lifetime, 600_000))
    : 0;
}

export class OAuthClients {
  private cache = new Map<string, { client: OAuthClient; expires: number }>();
  private pending = new Map<string, Promise<OAuthClient>>();
  private documents = new Map<string, Promise<ClientMetadataDocument>>();
  constructor(
    private db: Database,
    private configured: OAuthClient[],
    private guard: CredentialGuard,
    private fetchMetadata: ClientMetadataFetcher = fetchClientMetadata,
  ) {}
  private async fetchDocument(url: string) {
    metadataUrl(url);
    const pending = this.documents.get(url);
    if (pending) return pending;
    if (this.documents.size >= 32)
      throw new OAuthError(
        "temporarily_unavailable",
        "Client document request capacity reached",
        503,
      );
    const document = this.fetchMetadata(url);
    this.documents.set(url, document);
    try {
      return await document;
    } finally {
      this.documents.delete(url);
    }
  }
  async register(input: ClientMetadata) {
    const client_id = "vcl_" + randomBytes(32).toString("base64url");
    const client_secret = [
      "client_secret_basic",
      "client_secret_post",
    ].includes(input.token_endpoint_auth_method)
      ? "vcs_" + randomBytes(32).toString("base64url")
      : undefined;
    const created = await this.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext('vitalog-oauth-client-registration'))`,
      );
      const result = await transaction.execute(
        sql`select count(*)::integer as count from oauth_clients`,
      );
      if (Number(result.rows[0]?.count) >= 1000)
        throw new OAuthError(
          "temporarily_unavailable",
          "Client registration capacity reached",
          503,
        );
      const [row] = await transaction
        .insert(oauthClients)
        .values({
          clientId: client_id,
          metadata: input,
          clientSecretDigest: client_secret ? digest(client_secret) : undefined,
        })
        .returning({ createdAt: oauthClients.createdAt });
      return row!;
    });
    return {
      ...input,
      client_id,
      client_id_issued_at: Math.floor(created.createdAt.getTime() / 1000),
      ...(client_secret ? { client_secret, client_secret_expires_at: 0 } : {}),
    };
  }
  async resolve(id: string): Promise<OAuthClient> {
    const configured = this.configured.find(
      (client) => client.client_id === id,
    );
    if (configured) return configured;
    if (/^vcl_[A-Za-z0-9_-]{43}$/.test(id)) {
      const [registered] = await this.db
        .select()
        .from(oauthClients)
        .where(eq(oauthClients.clientId, id))
        .limit(1);
      if (!registered)
        throw new OAuthError("invalid_client", "Unknown client ID");
      return {
        ...metadata.parse(registered.metadata),
        client_id: id,
        ...(registered.clientSecretDigest
          ? { clientSecretDigest: registered.clientSecretDigest }
          : {}),
      };
    }
    metadataUrl(id);
    const cached = this.cache.get(id);
    if (cached && cached.expires > Date.now()) return cached.client;
    const existing = this.pending.get(id);
    if (existing) return existing;
    if (this.pending.size >= 32)
      throw new OAuthError(
        "temporarily_unavailable",
        "Client metadata request capacity reached",
        503,
      );
    const pending = this.load(id);
    this.pending.set(id, pending);
    try {
      return await pending;
    } finally {
      this.pending.delete(id);
    }
  }
  private async load(id: string) {
    try {
      const document = await this.fetchDocument(id);
      if (Buffer.byteLength(document.body) > 5120)
        throw new OAuthError("invalid_client", "Client metadata exceeds 5 KiB");
      this.guard(document.body);
      const source: unknown = JSON.parse(document.body);
      this.guard(JSON.stringify(source));
      const parsed = z
        .object({
          ...metadata.shape,
          client_id: z.literal(id),
          client_name: name,
          token_endpoint_auth_method: z
            .enum(["none", "private_key_jwt"])
            .default("none"),
          grant_types: z
            .array(z.string())
            .min(1)
            .max(10)
            .refine((values) => values.includes("authorization_code"))
            .default(["authorization_code"])
            .transform(() => ["authorization_code"] as ["authorization_code"]),
          response_types: z
            .array(z.string())
            .min(1)
            .max(10)
            .refine((values) => values.includes("code"))
            .default(["code"])
            .transform(() => ["code"] as ["code"]),
          client_secret: z.never().optional(),
          client_secret_expires_at: z.never().optional(),
        })
        .superRefine(validateKeySource)
        .safeParse(source);
      if (!parsed.success)
        throw new OAuthError(
          "invalid_client",
          "Invalid or unsupported client metadata",
        );
      const {
        client_secret: _secret,
        client_secret_expires_at: _expiry,
        grant_types: _grants,
        response_types: _responses,
        ...client
      } = parsed.data;
      const supportedClient: OAuthClient = {
        ...client,
        grant_types: ["authorization_code"],
        response_types: ["code"],
      };
      const lifetime = cacheLifetime(document);
      for (const [key, value] of this.cache)
        if (value.expires <= Date.now()) this.cache.delete(key);
      if (lifetime) {
        if (this.cache.size >= 100)
          this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(id, {
          client: supportedClient,
          expires: Date.now() + lifetime,
        });
      }
      return supportedClient;
    } catch (error) {
      if (error instanceof OAuthError) throw error;
      throw new OAuthError(
        "temporarily_unavailable",
        "Client metadata is unavailable",
        503,
      );
    }
  }
  async authenticate(
    id: string,
    suppliedSecret: string | undefined,
    method: "none" | "client_secret_basic" | "client_secret_post",
    assertion?: { jwt: string; issuer: string },
  ) {
    const client = await this.resolve(id);
    if (assertion) {
      if (
        method !== "none" ||
        client.token_endpoint_auth_method !== "private_key_jwt"
      )
        throw new OAuthError(
          "invalid_client",
          "Client authentication failed",
          401,
        );
      let jwks = client.jwks;
      if (client.jwks_uri) {
        const document = await this.fetchDocument(client.jwks_uri);
        if (Buffer.byteLength(document.body) > 5120)
          throw new OAuthError("invalid_client", "Client JWKS exceeds 5 KiB");
        this.guard(document.body);
        try {
          const decoded: unknown = JSON.parse(document.body);
          this.guard(JSON.stringify(decoded));
          jwks = publicJwks.parse(decoded);
        } catch {
          throw new OAuthError("invalid_client", "Invalid public JWKS", 401);
        }
      }
      if (!jwks)
        throw new OAuthError(
          "invalid_client",
          "Client public keys are unavailable",
          401,
        );
      await verifyClientAssertion(
        this.db,
        id,
        assertion.issuer,
        assertion.jwt,
        jwks as JSONWebKeySet,
        client.token_endpoint_auth_signing_alg,
      );
      return client;
    }
    if (
      client.token_endpoint_auth_method !== method ||
      (method !== "none" &&
        (!suppliedSecret ||
          !client.clientSecretDigest ||
          !timingSafeEqual(
            Buffer.from(digest(suppliedSecret)),
            Buffer.from(client.clientSecretDigest),
          )))
    )
      throw new OAuthError(
        "invalid_client",
        "Client authentication failed",
        401,
      );
    return client;
  }
}
