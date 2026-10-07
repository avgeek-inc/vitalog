import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { apiKeys, oauthCodes, oauthTokens } from "../db/schema.js";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const pkceChallenge = (value: string) =>
  createHash("sha256").update(value).digest("base64url");
export type OAuthGrant = {
  client_id: string;
  client_name?: string;
  redirect_uri: string;
  resource: string;
  scopes: string[];
  code_challenge: string;
};
export type CodeExchange = {
  code: string;
  client_id: string;
  redirect_uri: string;
  resource: string;
  code_verifier: string;
};

export class OAuthStore {
  private nextCleanup = 0;
  private cleaning?: Promise<void>;

  constructor(
    private db: Database,
    private resource: string,
  ) {}

  private async cleanup() {
    if (this.cleaning) return this.cleaning;
    if (Date.now() < this.nextCleanup) return;
    this.cleaning = (async () => {
      await this.db.execute(sql`
        delete from oauth_authorization_codes where code_digest in (
          select g.code_digest from oauth_authorization_codes g
          left join api_keys parent on parent.id = g.api_key_id
          where g.expires_at <= statement_timestamp()
            or parent.expires_at <= statement_timestamp()
            or parent.revoked_at is not null
          order by g.expires_at
          limit 1000 for update of g skip locked
        )
      `);
      await this.db.execute(sql`
        delete from oauth_access_tokens where token_digest in (
          select g.token_digest from oauth_access_tokens g
          join api_keys parent on parent.id = g.api_key_id
          where g.expires_at <= statement_timestamp()
            or parent.expires_at <= statement_timestamp()
            or parent.revoked_at is not null
          order by g.expires_at
          limit 1000 for update of g skip locked
        )
      `);
      this.nextCleanup = Date.now() + 60_000;
    })();
    try {
      await this.cleaning;
    } finally {
      this.cleaning = undefined;
    }
  }

  async issueCode(apiKeyId: string | undefined, grant: OAuthGrant) {
    await this.cleanup();
    const code = "voc_" + randomBytes(32).toString("base64url");
    await this.db.insert(oauthCodes).values({
      codeDigest: digest(code),
      apiKeyId,
      clientId: grant.client_id,
      clientName: grant.client_name,
      redirectUri: grant.redirect_uri,
      resource: grant.resource,
      scopes: grant.scopes,
      codeChallenge: grant.code_challenge,
    });
    return code;
  }

  async exchange(input: CodeExchange) {
    if (input.resource !== this.resource) return;
    await this.cleanup();
    return this.db.transaction(async (transaction) => {
      const [grant] = await transaction
        .select({
          apiKeyId: oauthCodes.apiKeyId,
          scopes: oauthCodes.scopes,
          clientName: oauthCodes.clientName,
        })
        .from(oauthCodes)
        .where(
          and(
            eq(oauthCodes.codeDigest, digest(input.code)),
            eq(oauthCodes.clientId, input.client_id),
            eq(oauthCodes.redirectUri, input.redirect_uri),
            eq(oauthCodes.resource, input.resource),
            eq(oauthCodes.codeChallenge, pkceChallenge(input.code_verifier)),
            isNull(oauthCodes.consumedAt),
            gt(oauthCodes.expiresAt, sql`clock_timestamp()`),
          ),
        )
        .for("update");
      if (!grant) return;
      const token = "vlo_" + randomBytes(32).toString("base64url");
      const projection = {
        id: apiKeys.id,
        expiresAt:
          sql<Date>`least(coalesce(${apiKeys.expiresAt}, statement_timestamp() + interval '720 hours'), statement_timestamp() + interval '720 hours')`.mapWith(
            apiKeys.expiresAt,
          ),
        remaining: sql<number>`floor(extract(epoch from (least(coalesce(${apiKeys.expiresAt}, statement_timestamp() + interval '720 hours'), statement_timestamp() + interval '720 hours') - clock_timestamp())))::integer`,
        tokenHint: apiKeys.tokenHint,
        access: apiKeys.access,
        includeAdmin: apiKeys.includeAdmin,
      };
      const [key] = grant.apiKeyId
        ? await transaction
            .select(projection)
            .from(apiKeys)
            .where(
              and(
                eq(apiKeys.id, grant.apiKeyId),
                isNull(apiKeys.revokedAt),
                or(
                  isNull(apiKeys.expiresAt),
                  gt(
                    apiKeys.expiresAt,
                    sql`clock_timestamp() + interval '1 second'`,
                  ),
                ),
              ),
            )
            .for("update")
        : await transaction
            .insert(apiKeys)
            .values({
              id: randomUUID(),
              tokenDigest: digest(token),
              tokenHint: "vlo_…" + token.slice(-4),
              oauthClientId: input.client_id,
              oauthClientName: grant.clientName,
              oauthScopes: grant.scopes,
              expiresAt: sql`statement_timestamp() + interval '720 hours'`,
            })
            .returning(projection);
      if (!key || key.remaining < 1) return;
      if (
        key.tokenHint.startsWith("vlk_") &&
        (key.access === null ||
          key.includeAdmin === null ||
          grant.scopes.some(
            (scope) => scope === "health:write" && key.access !== "edit",
          ))
      )
        return;
      await transaction
        .update(oauthCodes)
        .set({ apiKeyId: key.id, consumedAt: sql`clock_timestamp()` })
        .where(eq(oauthCodes.codeDigest, digest(input.code)));
      await transaction.insert(oauthTokens).values({
        tokenDigest: digest(token),
        apiKeyId: key.id,
        resource: input.resource,
        scopes: grant.scopes,
        expiresAt: key.expiresAt!,
      });
      return {
        access_token: token,
        token_type: "Bearer",
        expires_in: key.remaining,
        scope: grant.scopes.join(" "),
      };
    });
  }

  async authenticate(header: string | undefined) {
    if (!header || !/^Bearer vlo_[A-Za-z0-9_-]{43}$/.test(header)) return;
    await this.cleanup();
    const [grant] = await this.db
      .select({
        scopes: oauthTokens.scopes,
        tokenHint: apiKeys.tokenHint,
        access: apiKeys.access,
        includeAdmin: apiKeys.includeAdmin,
      })
      .from(oauthTokens)
      .innerJoin(apiKeys, eq(apiKeys.id, oauthTokens.apiKeyId))
      .where(
        and(
          eq(oauthTokens.tokenDigest, digest(header.slice(7))),
          eq(oauthTokens.resource, this.resource),
          gt(oauthTokens.expiresAt, sql`clock_timestamp()`),
          or(
            isNull(apiKeys.expiresAt),
            gt(apiKeys.expiresAt, sql`clock_timestamp()`),
          ),
          isNull(apiKeys.revokedAt),
        ),
      )
      .limit(1);
    if (!grant) return;
    if (!grant.tokenHint.startsWith("vlk_")) return { scopes: grant.scopes };
    if (grant.access === null || grant.includeAdmin === null) return;
    return {
      scopes: grant.scopes.filter(
        (scope) =>
          scope === "health:read" ||
          (scope === "health:write" && grant.access === "edit"),
      ),
    };
  }
}
