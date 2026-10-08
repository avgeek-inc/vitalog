import { and, eq, isNull, lt } from "drizzle-orm";
import { database } from "../src/db/client.js";
import { attachments } from "../src/db/schema.js";
import { attachmentStorageConfiguration } from "../src/attachments/config.js";
import { S3AttachmentStorage } from "../src/attachments/storage.js";
import { storedAttachment } from "../src/attachments/service.js";

async function pruneUploads() {
  const storageConfig = attachmentStorageConfiguration(process.env);
  if (!process.env.DATABASE_URL || !storageConfig)
    throw new Error("Database and storage configuration are required");
  const storage = new S3AttachmentStorage(storageConfig);
  const { db, pool } = database(process.env.DATABASE_URL);
  let removed = 0;
  try {
    // Expired URLs cannot recreate uploads; retain asset identities and idempotency history.
    for (;;) {
      const [row] = await db.transaction(async (tx) => {
        const candidates = await tx
          .select()
          .from(attachments)
          .where(
            and(
              lt(attachments.uploadExpiresAt, new Date().toISOString()),
              isNull(attachments.uploadPrunedAt),
            ),
          )
          .orderBy(attachments.id)
          .limit(1)
          .for("update", { skipLocked: true });
        const current = candidates[0];
        if (!current) return [];
        await storage.discardUpload(storedAttachment(current));
        const next = await tx
          .update(attachments)
          .set({
            status: current.status === "pending" ? "expired" : current.status,
            uploadPrunedAt: new Date().toISOString(),
          })
          .where(eq(attachments.id, current.id))
          .returning();
        return next;
      });
      if (!row) break;
      removed++;
    }
    process.stdout.write(
      JSON.stringify({ event: "attachment_uploads_pruned", removed }) + "\n",
    );
  } finally {
    await pool.end();
  }
}
await pruneUploads().catch(() => {
  process.stderr.write(
    '{"event":"attachment_pruning_failed","message":"Check database and matching S3 configuration; retry to continue cleanup"}\n',
  );
  process.exitCode = 1;
});
