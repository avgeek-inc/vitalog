import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { apiKeys, oauthTokens } from "../db/schema.js";

const resource = "urn:vitalog:key-management";
const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export class KeyManagementSessions {
  constructor(private db: Database) {}

  async create() {
    const token = "vlm_" + randomBytes(32).toString("base64url");
    return this.db.transaction(async (tx) => {
      const [key] = await tx
        .insert(apiKeys)
        .values({
          id: randomUUID(),
          tokenDigest: digest(token),
          tokenHint: "vlm_…" + token.slice(-4),
          expiresAt: sql`statement_timestamp() + interval '30 minutes'`,
        })
        .returning({ id: apiKeys.id, expiresAt: apiKeys.expiresAt });
      await tx.insert(oauthTokens).values({
        tokenDigest: digest(token),
        apiKeyId: key!.id,
        resource,
        scopes: ["keys:manage"],
        expiresAt: key!.expiresAt,
      });
      return {
        session_token: token,
        expires_at: key!.expiresAt.toISOString(),
      };
    });
  }

  async authenticate(header: string | undefined) {
    if (!header || !/^Bearer vlm_[A-Za-z0-9_-]{43}$/.test(header)) return;
    const [session] = await this.db
      .select({
        id: apiKeys.id,
        expiresAt: oauthTokens.expiresAt,
      })
      .from(oauthTokens)
      .innerJoin(apiKeys, eq(apiKeys.id, oauthTokens.apiKeyId))
      .where(
        and(
          eq(oauthTokens.tokenDigest, digest(header.slice(7))),
          eq(oauthTokens.resource, resource),
          sql`${oauthTokens.scopes} = array['keys:manage']::text[]`,
          gt(oauthTokens.expiresAt, sql`clock_timestamp()`),
          gt(apiKeys.expiresAt, sql`clock_timestamp()`),
          isNull(apiKeys.revokedAt),
        ),
      )
      .limit(1);
    return session;
  }

  async revoke(id: string) {
    await this.db
      .update(apiKeys)
      .set({ revokedAt: sql`clock_timestamp()` })
      .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)));
  }
}
