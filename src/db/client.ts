import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { schema } from "./schema.js";

export function database(url: string) {
  const pool = new pg.Pool({
    connectionString: url,
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
    query_timeout: 20_000,
  });
  pool.on("error", () => {
    process.stderr.write('{"event":"database_connection_error"}\n');
  });
  return { pool, db: drizzle(pool, { schema, logger: false }) };
}
export type Database = ReturnType<typeof database>["db"];
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
