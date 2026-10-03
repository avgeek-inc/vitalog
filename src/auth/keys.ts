import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, count, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { apiKeys } from "../db/schema.js";
import { DomainError } from "../errors.js";

const digest = (key: string) => createHash("sha256").update(key).digest("hex");
const projection = {
  id: apiKeys.id,
  token_hint: apiKeys.tokenHint,
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
  expires_at: Date;
  revoked_at: Date | null;
  status: "active" | "expired" | "revoked";
};
const metadata = (row: Row) => ({
  ...row,
  created_at: row.created_at.toISOString(),
  expires_at: row.expires_at.toISOString(),
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
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.tokenDigest, digest(header.slice(7))),
          isNull(apiKeys.revokedAt),
          gt(apiKeys.expiresAt, sql`clock_timestamp()`),
        ),
      )
      .limit(1);
    return rows[0];
  }

  async create() {
    const key = "vlk_" + randomBytes(32).toString("base64url");
    const rows = await this.db
      .insert(apiKeys)
      .values({
        id: randomUUID(),
        tokenDigest: digest(key),
        tokenHint: "vlk_…" + key.slice(-4),
      })
      .returning(projection);
    return { ...metadata(rows[0]!), api_key: key };
  }

  async list(limit: number, offset: number) {
    return this.db.transaction(
      async (transaction) => {
        const rows = await transaction
          .select(projection)
          .from(apiKeys)
          .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id))
          .limit(limit)
          .offset(offset);
        const totals = await transaction
          .select({ total: count() })
          .from(apiKeys);
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

  async revoke(id: string) {
    const rows = await this.db
      .update(apiKeys)
      .set({
        revokedAt: sql`coalesce(${apiKeys.revokedAt}, clock_timestamp())`,
      })
      .where(eq(apiKeys.id, id))
      .returning(projection);
    if (!rows[0]) throw new DomainError("NOT_FOUND", "API key does not exist");
    return metadata(rows[0]);
  }

  async revokeAll() {
    const result = await this.db.execute<{ revoked_count: number }>(sql`
      with revoked as (
        update ${apiKeys} set revoked_at = clock_timestamp()
        where revoked_at is null returning 1
      ) select count(*)::integer as revoked_count from revoked
    `);
    return result.rows[0]!;
  }
}
