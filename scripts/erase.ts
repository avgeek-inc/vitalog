import { sql } from "drizzle-orm";
import { database } from "../src/db/client.js";
import { WRITE_LOCK } from "../src/domain/store.js";
async function eraseDatabase() {
  if (!process.argv.includes("--confirm-permanent-erasure=ERASE_VITALOG"))
    throw new Error("Explicit erasure flag is required");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const { pool, db } = database(url);
  try {
    await db.transaction(async (tx) => {
      await tx.execute(WRITE_LOCK);
      await tx.execute(
        sql`truncate table record_revisions, idempotency_requests, health_records`,
      );
    });
    process.stdout.write(
      '{"event":"permanent_database_erasure_committed","backup_erasure_required":true}\n',
    );
  } finally {
    await pool.end();
  }
}
await eraseDatabase().catch(() => {
  process.stderr.write(
    '{"event":"erasure_failed","message":"Requires --confirm-permanent-erasure=ERASE_VITALOG and database access; stop the API and review backup retention first"}\n',
  );
  process.exitCode = 1;
});
