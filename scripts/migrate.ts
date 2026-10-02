import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { database } from "../src/db/client.js";
export async function migrateDatabase(url: string) {
  const { pool, db } = database(url);
  try {
    // A pinned connection serializes migrations across replicas and releases the lock on close.
    const client = await pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(84309211)");
      await migrate(db, {
        migrationsFolder: fileURLToPath(
          new URL(
            import.meta.url.includes("/dist/")
              ? "../../drizzle/"
              : "../drizzle/",
            import.meta.url,
          ),
        ),
      });
    } finally {
      client.release(true);
    }
  } finally {
    await pool.end();
  }
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  try {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is required");
    await migrateDatabase(url);
    process.stdout.write('{"event":"migrations_applied"}\n');
  } catch {
    process.stderr.write(
      '{"event":"migration_failed","message":"Check DATABASE_URL, database access and migration files"}\n',
    );
    process.exitCode = 1;
  }
}
