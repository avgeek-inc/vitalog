import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { apiKeys, oauthCodes, oauthTokens } from "../db/schema.js";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const pkceChallenge = (value: string) =>
  createHash("sha256").update(value).digest("base64url");
export type OAuthGrant = {
  client_id: string;
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
  constructor(
    private db: Database,
    private resource: string,
  ) {}

  async issueCode(apiKeyId: string, grant: OAuthGrant) {
    const code = "voc_" + randomBytes(32).toString("base64url");
    await this.db.insert(oauthCodes).values({
      codeDigest: digest(code),
      apiKeyId,
      clientId: grant.client_id,
      redirectUri: grant.redirect_uri,
      resource: grant.resource,
      scopes: grant.scopes,
      codeChallenge: grant.code_challenge,
    });
    return code;
  }

  async exchange(input: CodeExchange) {
    if (input.resource !== this.resource) return;
    return this.db.transaction(async (transaction) => {
      const [grant] = await transaction
        .select({
          apiKeyId: oauthCodes.apiKeyId,
          scopes: oauthCodes.scopes,
          expiresAt: apiKeys.expiresAt,
          remaining: sql<number>`floor(extract(epoch from (${apiKeys.expiresAt} - clock_timestamp())))::integer`,
        })
        .from(oauthCodes)
        .innerJoin(apiKeys, eq(apiKeys.id, oauthCodes.apiKeyId))
        .where(
          and(
            eq(oauthCodes.codeDigest, digest(input.code)),
            eq(oauthCodes.clientId, input.client_id),
            eq(oauthCodes.redirectUri, input.redirect_uri),
            eq(oauthCodes.resource, input.resource),
            eq(oauthCodes.codeChallenge, pkceChallenge(input.code_verifier)),
            isNull(oauthCodes.consumedAt),
            gt(oauthCodes.expiresAt, sql`clock_timestamp()`),
            isNull(apiKeys.revokedAt),
            gt(apiKeys.expiresAt, sql`clock_timestamp() + interval '1 second'`),
          ),
        )
        .for("update");
      if (!grant || grant.remaining < 1) return;
      await transaction
        .update(oauthCodes)
        .set({ consumedAt: sql`clock_timestamp()` })
        .where(eq(oauthCodes.codeDigest, digest(input.code)));
      const token = "vlo_" + randomBytes(32).toString("base64url");
      await transaction.insert(oauthTokens).values({
        tokenDigest: digest(token),
        apiKeyId: grant.apiKeyId,
        resource: input.resource,
        scopes: grant.scopes,
        expiresAt: grant.expiresAt,
      });
      return {
        access_token: token,
        token_type: "Bearer",
        expires_in: grant.remaining,
        scope: grant.scopes.join(" "),
      };
    });
  }

  async authenticate(header: string | undefined) {
    if (!header || !/^Bearer vlo_[A-Za-z0-9_-]{43}$/.test(header)) return;
    const [grant] = await this.db
      .select({ scopes: oauthTokens.scopes })
      .from(oauthTokens)
      .innerJoin(apiKeys, eq(apiKeys.id, oauthTokens.apiKeyId))
      .where(
        and(
          eq(oauthTokens.tokenDigest, digest(header.slice(7))),
          eq(oauthTokens.resource, this.resource),
          gt(oauthTokens.expiresAt, sql`clock_timestamp()`),
          gt(apiKeys.expiresAt, sql`clock_timestamp()`),
          isNull(apiKeys.revokedAt),
        ),
      )
      .limit(1);
    return grant;
  }
}
