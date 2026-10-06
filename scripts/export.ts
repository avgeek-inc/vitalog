import { database } from "../src/db/client.js";
import { once } from "node:events";

const write = async (value: unknown) => {
  if (!process.stdout.write(JSON.stringify(value) + "\n"))
    await once(process.stdout, "drain");
};
async function exportDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const { pool } = database(url);
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await write({
        format: "vitalog-export-jsonl",
        version: 1,
        exported_at: new Date().toISOString(),
      });
      await client.query(
        "DECLARE records NO SCROLL CURSOR FOR SELECT row_to_json(r) AS data FROM health_records r ORDER BY id",
      );
      await client.query(
        "DECLARE revisions NO SCROLL CURSOR FOR SELECT row_to_json(r) AS data FROM record_revisions r ORDER BY record_id, version",
      );
      await client.query(
        "DECLARE idempotency NO SCROLL CURSOR FOR SELECT row_to_json(r) AS data FROM idempotency_requests r ORDER BY operation, idempotency_key",
      );
      await client.query(
        "DECLARE goals NO SCROLL CURSOR FOR SELECT row_to_json(r) AS data FROM goals r ORDER BY id",
      );
      await client.query(
        "DECLARE goal_revisions NO SCROLL CURSOR FOR SELECT row_to_json(r) AS data FROM goal_revisions r ORDER BY goal_id, version",
      );
      await client.query(
        "DECLARE goal_idempotency NO SCROLL CURSOR FOR SELECT row_to_json(r) AS data FROM goal_idempotency_requests r ORDER BY operation, idempotency_key",
      );
      for (const [table, query] of [
        ["health_records", "FETCH 100 FROM records"],
        ["record_revisions", "FETCH 100 FROM revisions"],
        ["idempotency_requests", "FETCH 100 FROM idempotency"],
        ["goals", "FETCH 100 FROM goals"],
        ["goal_revisions", "FETCH 100 FROM goal_revisions"],
        ["goal_idempotency_requests", "FETCH 100 FROM goal_idempotency"],
      ]) {
        while (true) {
          const result = await client.query(query!);
          for (const row of result.rows) await write({ table, data: row.data });
          if (result.rows.length < 100) break;
        }
      }
      await client.query("COMMIT");
    } finally {
      client.release(true);
    }
  } finally {
    await pool.end();
  }
}
await exportDatabase().catch(() => {
  process.stderr.write(
    '{"event":"export_failed","message":"Check DATABASE_URL and database access; discard any incomplete export"}\n',
  );
  process.exitCode = 1;
});
