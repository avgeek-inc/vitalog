import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, count, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { apiKeys, oauthCodes } from "../db/schema.js";
import { manualKeyCreation } from "./contracts.js";
import type { z } from "zod";
import { DomainError } from "../errors.js";

const digest = (key: string) => createHash("sha256").update(key).digest("hex");
const projection = {
  id: apiKeys.id,
  token_hint: apiKeys.tokenHint,
  name: apiKeys.name,
  access: apiKeys.access,
  includeAdmin: apiKeys.includeAdmin,
  oauth_client_id: apiKeys.oauthClientId,
  oauth_client_name: apiKeys.oauthClientName,
  oauth_scopes: apiKeys.oauthScopes,
  created_at: apiKeys.createdAt,
  expires_at: apiKeys.expiresAt,
  revoked_at: apiKeys.revokedAt,
  status: sql<
    "active" | "expired" | "revoked"
  >`case when ${apiKeys.revokedAt} is not null then 'revoked' when ${apiKeys.expiresAt} <= clock_timestamp() then 'expired' else 'active' end`,
};
type Row = {
  id: string;
  token_hint: string;
  created_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  status: "active" | "expired" | "revoked";
};
const metadata = (row: Row) => ({
  ...row,
  created_at: row.created_at.toISOString(),
  expires_at: row.expires_at?.toISOString() ?? null,
  revoked_at: row.revoked_at?.toISOString() ?? null,
});

export class ApiKeys {
  constructor(private db: Database) {}

  async authorized(header: string | undefined): Promise<boolean> {
    return !!(await this.findActive(header));
  }

  async findActive(header: string | undefined) {
    if (!header || !/^Bearer vlk_[A-Za-z0-9_-]{43}$/.test(header)) return;
    const rows = await this.db
      .select({
        id: apiKeys.id,
        access: apiKeys.access,
        includeAdmin: apiKeys.includeAdmin,
      })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.tokenDigest, digest(header.slice(7))),
          isNull(apiKeys.revokedAt),
          or(
            isNull(apiKeys.expiresAt),
            gt(apiKeys.expiresAt, sql`clock_timestamp()`),
          ),
        ),
      )
      .limit(1);
    const key = rows[0];
    if (
      !key ||
      !["read", "edit"].includes(key.access ?? "") ||
      key.includeAdmin === null ||
      (key.includeAdmin && key.access !== "edit")
    )
      return;
    return key;
  }

  async create(input: z.infer<typeof manualKeyCreation>, requestId?: string) {
    const settings = manualKeyCreation.parse(input);
    const creationDigest = digest(JSON.stringify(settings));
    return this.db.transaction(async (tx) => {
      if (requestId) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${requestId}))`,
        );
        const [previous] = await tx
          .select({ ...projection, creationDigest: apiKeys.creationDigest })
          .from(apiKeys)
          .where(eq(apiKeys.creationRequestId, requestId));
        if (previous) {
          if (previous.creationDigest !== creationDigest)
            throw new DomainError(
              "IDEMPOTENCY_CONFLICT",
              "This request ID was already used with different key settings",
            );
          const { creationDigest: _digest, ...stored } = previous;
          return { ...metadata(stored), api_key: null };
        }
      }
      const key = "vlk_" + randomBytes(32).toString("base64url");
      const [created] = await tx
        .insert(apiKeys)
        .values({
          id: randomUUID(),
          tokenDigest: digest(key),
          tokenHint: "vlk_…" + key.slice(-4),
          name: settings.name,
          access: settings.access,
          includeAdmin: settings.includeAdmin,
          expiresAt:
            settings.expiresAt === null ? null : new Date(settings.expiresAt),
          creationRequestId: requestId,
          creationDigest: requestId ? creationDigest : null,
        })
        .returning(projection);
      return { ...metadata(created!), api_key: key };
    });
  }

  async list(
    limit: number,
    offset: number,
    externalOnly = false,
    kind?: "api-key" | "mcp",
  ) {
    const filter = externalOnly
      ? and(
          kind
            ? eq(
                sql`left(${apiKeys.tokenHint}, 4)`,
                kind === "mcp" ? "vlo_" : "vlk_",
              )
            : sql`left(${apiKeys.tokenHint}, 4) in ('vlk_', 'vlo_')`,
          isNull(apiKeys.revokedAt),
        )
      : undefined;
    return this.db.transaction(
      async (transaction) => {
        const rows = await transaction
          .select(projection)
          .from(apiKeys)
          .where(filter)
          .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id))
          .limit(limit)
          .offset(offset);
        const totals = await transaction
          .select({ total: count() })
          .from(apiKeys)
          .where(filter);
        return {
          api_keys: rows.map(metadata),
          total: totals[0]!.total,
          limit,
          offset,
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async revoke(id: string, externalOnly = false) {
    const rows = await this.db
      .update(apiKeys)
      .set({
        revokedAt: sql`coalesce(${apiKeys.revokedAt}, clock_timestamp())`,
      })
      .where(
        and(
          eq(apiKeys.id, id),
          externalOnly
            ? sql`left(${apiKeys.tokenHint}, 4) in ('vlk_', 'vlo_')`
            : undefined,
        ),
      )
      .returning(projection);
    if (!rows[0]) throw new DomainError("NOT_FOUND", "API key does not exist");
    return metadata(rows[0]);
  }

  async revokeAll(externalOnly = false, kind?: "api-key" | "mcp") {
    return this.db.transaction(async (transaction) => {
      if (kind !== "api-key")
        await transaction
          .delete(oauthCodes)
          .where(isNull(oauthCodes.consumedAt));
      const result = await transaction.execute<{ revoked_count: number }>(sql`
        with revoked as (
          update ${apiKeys} set revoked_at = clock_timestamp()
          where revoked_at is null
            ${kind ? sql`and left(token_hint, 4) = ${kind === "mcp" ? "vlo_" : "vlk_"}` : externalOnly ? sql`and left(token_hint, 4) in ('vlk_', 'vlo_')` : sql``}
          returning 1
        ) select count(*)::integer as revoked_count from revoked
      `);
      return result.rows[0]!;
    });
  }
}
