import { serve } from "@hono/node-server";
import { Server } from "node:http";
import { application } from "./app.js";
import { configuration } from "./config.js";
import { database } from "./db/client.js";
import { Service } from "./service.js";
import { S3AttachmentStorage } from "./attachments/storage.js";

async function start() {
  const config = configuration();
  const { pool, db } = database(config.databaseUrl);
  const service = new Service(
    db,
    config.timezone,
    config.authDigest.toString("hex"),
    config.attachmentStorage
      ? new S3AttachmentStorage(config.attachmentStorage)
      : undefined,
  );
  if (!(await service.ready())) {
    await pool.end();
    throw new Error(
      "Database is unavailable or migrations have not been applied",
    );
  }
  const server = serve({
    fetch: application(service, config).fetch,
    port: config.port,
    hostname: "0.0.0.0",
  });
  if (server instanceof Server) {
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5000;
  }
  process.stdout.write(
    JSON.stringify({ event: "listening", port: config.port }) + "\n",
  );
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
    setTimeout(() => {
      if (server instanceof Server) server.closeAllConnections();
      void pool.end().finally(() => process.exit(1));
    }, 30_000).unref();
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}
start().catch(() => {
  process.stderr.write(
    '{"event":"startup_failed","message":"Check required environment, host configuration, database access and applied migrations"}\n',
  );
  process.exitCode = 1;
});
