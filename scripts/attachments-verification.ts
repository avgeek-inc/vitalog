import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { Server } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  S3Client,
  CreateBucketCommand,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { application } from "../src/app.js";
import { configuration } from "../src/config.js";
import { database } from "../src/db/client.js";
import { Service } from "../src/service.js";
import { S3AttachmentStorage } from "../src/attachments/storage.js";
import { ApiKeys } from "../src/auth/keys.js";
import { BrowserSessions } from "../src/auth/sessions.js";
import { OAuthStore, pkceChallenge } from "../src/auth/oauth-store.js";
import { object, type Data, type HealthRecord } from "../src/domain/types.js";
import { operationByName, operations } from "../src/registry/operations.js";
import { MAX_ATTACHMENT_BYTES } from "../src/registry/attachments.js";
import { examples } from "../tests/fixtures.js";
import {
  fileMetadata,
  png,
  pdf,
  pdfFile,
} from "../tests/attachment-fixtures.js";
import { migrateDatabase } from "./migrate.js";

const postgresContainer = `vitalog-attachments-pg-${process.pid}`;
const minioContainer = `vitalog-attachments-s3-${process.pid}`;
const minioImage =
  "cgr.dev/chainguard/minio@sha256:a05a4497e8dce3cb7a7a1bf1872ba5d30ea988f1e8c22c9e0920503761c4b5f1";
const password = randomBytes(32).toString("hex");
const key = randomBytes(48).toString("base64url");
const accessKey = randomBytes(16).toString("hex");
const storageSecret = randomBytes(32).toString("hex");
const bucket = `vitalog-attachments-${process.pid}`;
const checks: string[] = [];
const logs: Data[] = [];
const command = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
  execFileSync("docker", args, {
    env,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 1024 * 1024,
  }).trim();
let connection: ReturnType<typeof database> | undefined;
let server: Server | undefined;
let client: Client | undefined;
let s3: S3Client | undefined;
let baselineFolder: string | undefined;
let baseUrl = "";
let app: ReturnType<typeof application>;
let operatorEnv: NodeJS.ProcessEnv;
async function check(name: string, action: () => Promise<void>) {
  process.stdout.write(`RUN ${name}\n`);
  await action();
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}
async function rest(
  path: string,
  body?: Data,
  idem: string = randomUUID(),
  token = key,
) {
  const response = await fetch(baseUrl + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body
        ? { "Content-Type": "application/json", "Idempotency-Key": idem }
        : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: object(await response.json()) };
}
async function call(name: string, input: Data, instance = client!) {
  const response = await instance.callTool({ name, arguments: input });
  assert(!response.isError, `MCP ${name} failed`);
  const result = object(response.structuredContent);
  operationByName.get(name)!.output.parse(result);
  return result;
}
async function upload(intent: Data, bytes: Uint8Array) {
  const spec = object(intent.upload);
  const response = await fetch(String(spec.url), {
    method: "PUT",
    headers: spec.headers as Record<string, string>,
    body: Buffer.from(bytes),
  });
  assert.equal(response.status, 200, "Signed upload failed");
}
async function missingObject(objectKey: string) {
  await assert.rejects(
    s3!.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey })),
    (error: unknown) => object(object(error).$metadata).httpStatusCode === 404,
  );
}
async function connect(token: string) {
  const instance = new Client({
    name: "generic-attachment-client",
    version: "1",
  });
  await instance.connect(
    new StreamableHTTPClientTransport(new URL(baseUrl + "/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return instance;
}
try {
  command(
    [
      "run",
      "--detach",
      "--rm",
      "--name",
      postgresContainer,
      "-e",
      "POSTGRES_PASSWORD",
      "-e",
      "POSTGRES_USER=vitalog",
      "-e",
      "POSTGRES_DB=vitalog",
      "-p",
      "127.0.0.1::5432",
      "postgres:17.11-bookworm",
    ],
    { ...process.env, POSTGRES_PASSWORD: password },
  );
  command(
    [
      "run",
      "--detach",
      "--rm",
      "--name",
      minioContainer,
      "-e",
      "MINIO_ROOT_USER",
      "-e",
      "MINIO_ROOT_PASSWORD",
      "--tmpfs",
      "/data:rw,size=1g,mode=1777",
      "-p",
      "127.0.0.1::9000",
      minioImage,
      "server",
      "/data",
    ],
    {
      ...process.env,
      MINIO_ROOT_USER: accessKey,
      MINIO_ROOT_PASSWORD: storageSecret,
    },
  );
  const storagePort = command(["port", minioContainer, "9000/tcp"])
    .split(":")
    .at(-1)!;
  const endpoint = `http://127.0.0.1:${storagePort}`;
  let storageReady = false;
  let databaseReady = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      command([
        "exec",
        postgresContainer,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "vitalog",
      ]);
      databaseReady = true;
    } catch {
      /* Wait for this test container. */
    }
    try {
      storageReady = (await fetch(endpoint + "/minio/health/ready")).ok;
    } catch {
      /* Wait for this test container. */
    }
    if (storageReady && databaseReady) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert(
    storageReady && databaseReady,
    "Local PostgreSQL/MinIO did not become ready",
  );
  const pgPort = command(["port", postgresContainer, "5432/tcp"])
    .split(":")
    .at(-1)!;
  const databaseUrl = `postgresql://vitalog:${password}@127.0.0.1:${pgPort}/vitalog`;
  connection = database(databaseUrl);
  await check(
    "Upgrade existing ledger and apply attachment migration twice",
    async () => {
      baselineFolder = await mkdtemp(
        join(tmpdir(), "vitalog-attachment-upgrade-"),
      );
      await mkdir(join(baselineFolder, "meta"));
      const journal = JSON.parse(
        await readFile("drizzle/meta/_journal.json", "utf8"),
      );
      const attachmentMigration = journal.entries.find(
        (entry: { tag: string }) => entry.tag === "0011_reusable_attachments",
      );
      assert(
        attachmentMigration,
        "Attachment migration must exist in the journal",
      );
      journal.entries = journal.entries.filter(
        (entry: { idx: number }) => entry.idx < attachmentMigration.idx,
      );
      await writeFile(
        join(baselineFolder, "meta/_journal.json"),
        JSON.stringify(journal),
      );
      for (const entry of journal.entries)
        await writeFile(
          join(baselineFolder, `${entry.tag}.sql`),
          await readFile(`drizzle/${entry.tag}.sql`),
        );
      await migrate(connection!.db, { migrationsFolder: baselineFolder });
      await connection!.pool.query(
        `insert into health_records (id, record_type, schema_version, version, occurred_on, timezone, time_precision, date_basis, recorded_at, updated_at, status, validity, provenance, payload) values ($1, 'nutrition', 2, 1, $2, 'Asia/Kolkata', 'date', 'reported_date', now(), now(), 'active', 'valid', $3, $4)`,
        [
          randomUUID(),
          examples.nutrition.occurred_on,
          JSON.stringify(examples.nutrition.provenance),
          JSON.stringify(examples.nutrition.data),
        ],
      );
      await migrateDatabase(databaseUrl);
      await migrateDatabase(databaseUrl);
      const upgraded = await connection!.pool.query(
        "select attachment_ids from health_records",
      );
      assert.deepEqual(upgraded.rows[0].attachment_ids, []);
    },
  );
  s3 = new S3Client({
    endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: accessKey, secretAccessKey: storageSecret },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  const instance = serve({
    fetch: (request, bindings) =>
      app ? app.fetch(request, bindings) : new Response(null, { status: 503 }),
    port: 0,
    hostname: "127.0.0.1",
  });
  assert(instance instanceof Server);
  server = instance;
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
  operatorEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    S3_ENDPOINT: endpoint,
    S3_BUCKET: bucket,
    S3_REGION: "us-east-1",
    S3_ACCESS_KEY_ID: accessKey,
    S3_SECRET_ACCESS_KEY: storageSecret,
    S3_PREFIX: "vitalog",
    S3_FORCE_PATH_STYLE: "true",
  };
  const config = configuration({
    ...operatorEnv,
    AUTH_KEY: key,

    PUBLIC_BASE_URL: baseUrl,
    RATE_LIMIT_PER_MINUTE: "100000",
  });
  const storage = new S3AttachmentStorage(config.attachmentStorage!);
  const service = new Service(
    connection.db,
    "attachment-verification",
    storage,
  );
  app = application(service, config, (entry) => logs.push(entry));
  client = await connect(key);
  let imageIntent: Data;
  let imageId = "";
  let reportId = "";
  let nutritionId = "";
  await check(
    "Private image/PDF upload, cross-transport retries and signed downloads",
    async () => {
      assert.equal((await rest("/readyz")).status, 200);
      assert.equal((await client!.listTools()).tools.length, operations.length);
      assert.equal((await fetch(baseUrl + "/v1/attachments")).status, 401);
      imageIntent = await call("health_create_attachment_upload", {
        ...fileMetadata(png),
        idempotency_key: "image-reservation",
      });
      imageId = String(object(imageIntent.attachment).id);
      const retry = await rest(
        "/v1/attachments/uploads",
        fileMetadata(png),
        "image-reservation",
      );
      assert.equal(retry.status, 200);
      assert.equal(retry.body.idempotent_replay, true);
      assert.deepEqual(retry.body.attachment, imageIntent.attachment);
      assert.equal(
        (await rest(`/v1/attachments/${imageId}/download`)).status,
        422,
      );
      assert.equal(
        (await rest(`/v1/attachments/${imageId}/complete`, {}, "not-uploaded"))
          .status,
        422,
      );
      await upload(imageIntent, png);
      const results = await Promise.all([
        rest(`/v1/attachments/${imageId}/complete`, {}, "image-completion"),
        call("health_complete_attachment_upload", {
          id: imageId,
          idempotency_key: "image-completion",
        }),
      ]);
      assert.equal(results[0].status, 200);
      assert.equal(object(results[0].body.attachment).status, "ready");
      assert.deepEqual(results[0].body.attachment, results[1].attachment);
      const download = await call("health_get_attachment_download", {
        id: imageId,
      });
      const downloaded = await fetch(String(object(download.download).url));
      assert.equal(downloaded.status, 200);
      assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png);
      assert.match(
        downloaded.headers.get("content-disposition")!,
        /^attachment;/,
      );
      assert.equal(
        downloaded.headers.get("cache-control"),
        "private, no-store",
      );
      const bareUrl = new URL(String(object(download.download).url));
      bareUrl.search = "";
      assert.equal((await fetch(bareUrl)).status, 403);
      const report = await rest(
        "/v1/attachments/uploads",
        fileMetadata(pdf, "application/pdf", "lab report.pdf"),
        "report-reservation",
      );
      assert.equal(report.status, 200);
      reportId = String(object(report.body.attachment).id);
      await upload(report.body, pdf);
      const completed = await call("health_complete_attachment_upload", {
        id: reportId,
        idempotency_key: "report-completion",
      });
      assert.equal(object(completed.attachment).status, "ready");
      const conflict = await rest(
        "/v1/attachments/uploads",
        { ...fileMetadata(png), filename: "different.png" },
        "image-reservation",
      );
      assert.equal(conflict.status, 409);
      const completedRetry = await rest(
        "/v1/attachments/uploads",
        fileMetadata(png),
        "image-reservation",
      );
      assert.equal(completedRetry.body.upload, null);
    },
  );
  await check(
    "One asset serves nutrition, weight, all other log types and shared lab batches",
    async () => {
      for (const operation of operations.filter((entry) => entry.record_type)) {
        const input = {
          ...examples[operation.record_type!],
          attachment_ids: [imageId],
        };
        const result = await call(operation.name, {
          idempotency_key: `reuse-${operation.record_type}`,
          ...(operation.batch ? { records: [input] } : input),
        });
        const record = operation.batch
          ? (result.records as HealthRecord[])[0]!
          : (result.record as HealthRecord);
        assert.deepEqual(record.attachment_ids, [imageId]);
        if (operation.record_type === "nutrition") nutritionId = record.id;
      }
      const batch = await rest(
        "/v1/lab-results",
        {
          shared_metadata: {
            occurred_on: examples.lab_result.occurred_on,
            provenance: examples.lab_result.provenance,
            attachment_ids: [reportId],
          },
          records: [
            { data: examples.lab_result.data },
            { data: examples.lab_result.data },
          ],
        },
        "shared-report-batch",
      );
      assert.equal(batch.status, 200);
      assert(
        (batch.body.records as HealthRecord[]).every(
          (record) =>
            JSON.stringify(record.attachment_ids) ===
            JSON.stringify([reportId]),
        ),
      );
      const objects = await s3!.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: "vitalog/objects/",
        }),
      );
      assert.equal(objects.KeyCount, 2);
      const references = await connection!.pool.query(
        "select count(*)::int as count from record_attachments where attachment_id=$1",
        [imageId],
      );
      assert.equal(references.rows[0].count, 8);
      const before = await connection!.pool.query(
        "select count(*)::int as count from health_records",
      );
      const badBatch = await rest(
        "/v1/measurements",
        {
          records: [
            { ...examples.measurement, attachment_ids: [imageId] },
            { ...examples.measurement, attachment_ids: [randomUUID()] },
          ],
        },
        "invalid-reference-batch",
      );
      assert.equal(badBatch.status, 422);
      const after = await connection!.pool.query(
        "select count(*)::int as count from health_records",
      );
      assert.deepEqual(after.rows, before.rows);
    },
  );
  await check(
    "Corrections, voids and pagination preserve attachment links per revision",
    async () => {
      const correction = await rest(
        `/v1/records/${nutritionId}/corrections`,
        {
          expected_version: 1,
          reason: "Replace supporting file",
          replacement: {
            record_type: "nutrition",
            ...examples.nutrition,
            attachment_ids: [reportId],
          },
        },
        "replace-evidence",
      );
      assert.equal(correction.status, 200);
      assert.deepEqual(
        (await rest(`/v1/attachments?record_id=${nutritionId}`)).body
          .attachments,
        [(await rest(`/v1/attachments/${reportId}`)).body.attachment],
      );
      assert.deepEqual(
        (
          await call("health_list_attachments", {
            record_id: nutritionId,
            record_version: 1,
          })
        ).attachments,
        [(await call("health_get_attachment", { id: imageId })).attachment],
      );
      const voided = await rest(`/v1/records/${nutritionId}/voids`, {
        expected_version: 2,
        reason: "Void fixture event",
      });
      assert.equal(voided.status, 200);
      assert.deepEqual(object(voided.body.record).attachment_ids, [reportId]);
      const history = await rest(
        `/v1/records/${nutritionId}?include_history=true`,
      );
      assert.deepEqual(
        (history.body.history as Data[]).map(
          (revision) => object(revision.snapshot).attachment_ids,
        ),
        [[reportId], [reportId], [imageId]],
      );
      assert.equal(
        (
          await rest(
            `/v1/attachments?record_id=${nutritionId}&record_version=100`,
          )
        ).status,
        404,
      );
      assert.equal(
        (await rest("/v1/attachments?record_version=1")).status,
        422,
      );
      const page = await rest("/v1/attachments?limit=1&status=ready");
      assert.equal(page.body.has_more, true);
      const next = await rest(
        `/v1/attachments?limit=1&status=ready&cursor=${encodeURIComponent(String(page.body.next_cursor))}`,
      );
      assert.equal(next.body.returned_count, 1);
      assert.notEqual(
        (page.body.attachments as Data[])[0]!.id,
        (next.body.attachments as Data[])[0]!.id,
      );
      assert.equal(
        (
          await rest(
            `/v1/attachments?limit=2&status=ready&cursor=${encodeURIComponent(String(page.body.next_cursor))}`,
          )
        ).status,
        422,
      );
    },
  );
  await check(
    "Real object storage enforces signed length/type and immutable completed bytes",
    async () => {
      const spec = object(imageIntent!.upload);
      const headers = { "Content-Type": "image/png" };
      assert.equal(
        (
          await fetch(String(spec.url), {
            method: "PUT",
            headers,
            body: Buffer.concat([png, Buffer.from([0])]),
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await fetch(String(spec.url), {
            method: "PUT",
            headers: {
              "Content-Type": "application/pdf",
              "Content-Length": String(png.length),
            },
            body: png,
          })
        ).status,
        403,
      );
      const changed = Buffer.from(png);
      changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
      await upload(imageIntent!, changed);
      const downloaded = await call("health_get_attachment_download", {
        id: imageId,
      });
      assert.deepEqual(
        Buffer.from(
          await (
            await fetch(String(object(downloaded.download).url))
          ).arrayBuffer(),
        ),
        png,
      );
      const completeAgain = await rest(
        `/v1/attachments/${imageId}/complete`,
        {},
        "image-completion-new-key",
      );
      assert.equal(completeAgain.status, 200);
      assert.deepEqual(
        Buffer.from(
          await (
            await s3!.send(
              new GetObjectCommand({
                Bucket: bucket,
                Key: `vitalog/objects/${imageId}`,
              }),
            )
          ).Body!.transformToByteArray(),
        ),
        png,
      );
    },
  );
  await check(
    "Actual 20 MB PDF succeeds; oversized, spoofed, checksum and missing files fail",
    async () => {
      let padding = MAX_ATTACHMENT_BYTES - pdf.length;
      let large = pdfFile(padding);
      while (large.length !== MAX_ATTACHMENT_BYTES) {
        padding += MAX_ATTACHMENT_BYTES - large.length;
        large = pdfFile(padding);
      }
      assert.equal(large.length, MAX_ATTACHMENT_BYTES);
      const intent = await call("health_create_attachment_upload", {
        ...fileMetadata(large, "application/pdf", "large.pdf"),
        idempotency_key: "maximum-pdf",
      });
      await upload(intent, large);
      const ready = await rest(
        `/v1/attachments/${object(intent.attachment).id}/complete`,
        {},
      );
      assert.equal(ready.status, 200);
      assert.equal(
        (
          await rest("/v1/attachments/uploads", {
            ...fileMetadata(large, "application/pdf", "too-large.pdf"),
            byte_length: MAX_ATTACHMENT_BYTES + 1,
          })
        ).status,
        422,
      );
      for (const [label, declared, bytes] of [
        [
          "wrong-checksum",
          { ...fileMetadata(png), sha256: "0".repeat(64) },
          png,
        ],
        [
          "spoofed-type",
          fileMetadata(png, "application/pdf", "not-a-pdf.pdf"),
          png,
        ],
        [
          "svg",
          fileMetadata(Buffer.from("<svg onload='alert(1)'></svg>")),
          Buffer.from("<svg onload='alert(1)'></svg>"),
        ],
      ] as const) {
        const pending = await rest("/v1/attachments/uploads", declared, label);
        assert.equal(pending.status, 200);
        await upload(pending.body, bytes);
        const id = String(object(pending.body.attachment).id);
        const failure = await rest(`/v1/attachments/${id}/complete`, {}, label);
        assert.equal(failure.status, 422);
        assert.equal(
          object((await rest(`/v1/attachments/${id}`)).body.attachment).status,
          "pending",
        );
        assert.equal(
          (
            await rest("/v1/nutrition", {
              ...examples.nutrition,
              attachment_ids: [id],
            })
          ).status,
          422,
        );
        await missingObject(`vitalog/objects/${id}`);
      }
      const dishonest = await rest(
        "/v1/attachments/uploads",
        fileMetadata(png),
        "oversized-storage",
      );
      const dishonestId = String(object(dishonest.body.attachment).id);
      await s3!.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: `vitalog/uploads/${dishonestId}`,
          ContentType: "image/png",
          Body: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1),
        }),
      );
      assert.equal(
        (await rest(`/v1/attachments/${dishonestId}/complete`, {})).status,
        413,
      );
      await missingObject(`vitalog/objects/${dishonestId}`);
    },
  );
  await check(
    "API keys, read-only browser sessions and OAuth read/write scopes apply to files",
    async () => {
      const manual = await new ApiKeys(connection!.db).create({
        name: "Verification",
        access: "edit",
        includeAdmin: false,
        expiresAt: null,
      });
      assert.equal(
        (
          await rest(
            `/v1/attachments/${imageId}`,
            undefined,
            randomUUID(),
            manual.api_key!,
          )
        ).status,
        200,
      );
      const browser = await new BrowserSessions(connection!.db).create();
      assert.equal(
        (
          await rest(
            `/v1/attachments/${imageId}/download`,
            undefined,
            randomUUID(),
            browser.session_token,
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await rest(
            "/v1/attachments/uploads",
            fileMetadata(png),
            randomUUID(),
            browser.session_token,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await rest(
            `/v1/attachments/${reportId}/complete`,
            {},
            randomUUID(),
            browser.session_token,
          )
        ).status,
        403,
      );
      for (const scopes of [["health:read"], ["health:write"]]) {
        const oauth = new OAuthStore(connection!.db, baseUrl + "/mcp");
        const verifier = randomBytes(32).toString("base64url");
        const grant = {
          client_id: "generic-attachments",
          redirect_uri: "http://127.0.0.1/oauth/callback",
          resource: baseUrl + "/mcp",
          scopes,
          code_challenge: pkceChallenge(verifier),
        };
        const code = await oauth.issueCode(undefined, grant);
        const issued = await oauth.exchange({
          ...grant,
          code,
          code_verifier: verifier,
        });
        assert(issued);
        const instance = await connect(issued.access_token);
        try {
          if (scopes.includes("health:read")) {
            await call(
              "health_get_attachment_download",
              { id: imageId },
              instance,
            );
            await assert.rejects(
              instance.callTool({
                name: "health_create_attachment_upload",
                arguments: {
                  ...fileMetadata(png),
                  idempotency_key: "forbidden-oauth-upload",
                },
              }),
            );
          } else {
            const reserved = await call(
              "health_create_attachment_upload",
              { ...fileMetadata(png), idempotency_key: "oauth-upload" },
              instance,
            );
            await upload(reserved, png);
            await call(
              "health_complete_attachment_upload",
              {
                id: object(reserved.attachment).id,
                idempotency_key: "oauth-complete",
              },
              instance,
            );
            await assert.rejects(
              instance.callTool({
                name: "health_get_attachment_download",
                arguments: { id: imageId },
              }),
            );
          }
          assert.equal(
            (
              await rest(
                "/v1/attachments",
                undefined,
                randomUUID(),
                issued.access_token,
              )
            ).status,
            401,
          );
        } finally {
          await instance.close();
        }
      }
      const secretName = await rest("/v1/attachments/uploads", {
        ...fileMetadata(png),
        filename: storageSecret,
      });
      assert.equal(secretName.status, 422);
      assert(!JSON.stringify(logs).includes(key));
      assert(!JSON.stringify(logs).includes(storageSecret));
      assert(!JSON.stringify(logs).includes("X-Amz-Signature"));
      const disabled = new Service(connection!.db, "disabled-storage");
      assert.equal(
        (await disabled.execute("health_get_attachment", { id: imageId }))
          .attachment !== undefined,
        true,
      );
      await assert.rejects(
        disabled.execute("health_create_attachment_upload", {
          ...fileMetadata(png),
          idempotency_key: "disabled",
        }),
        (error: unknown) => object(error).code === "UNAVAILABLE",
      );
    },
  );
  await check(
    "Metadata export, completed upload replay after restore, expired staging cleanup and scoped erasure",
    async () => {
      const exported = execFileSync(
        process.execPath,
        ["--import", "tsx", "scripts/export.ts"],
        { env: operatorEnv, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      );
      const rows = exported
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      for (const table of [
        "attachments",
        "record_attachments",
        "attachment_idempotency_requests",
      ])
        assert(rows.some((row) => row.table === table));
      assert(!exported.includes(storageSecret));
      assert(!exported.includes("X-Amz-Signature"));
      const dump = execFileSync(
        "docker",
        [
          "exec",
          postgresContainer,
          "pg_dump",
          "-U",
          "vitalog",
          "-d",
          "vitalog",
          "--format=custom",
          "--no-owner",
          "--no-privileges",
        ],
        { maxBuffer: 8 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] },
      );
      command([
        "exec",
        postgresContainer,
        "createdb",
        "-U",
        "vitalog",
        "vitalog_restore",
      ]);
      execFileSync(
        "docker",
        [
          "exec",
          "-i",
          postgresContainer,
          "pg_restore",
          "-U",
          "vitalog",
          "-d",
          "vitalog_restore",
          "--no-owner",
          "--no-privileges",
          "--exit-on-error",
        ],
        { input: dump, stdio: ["pipe", "pipe", "pipe"] },
      );
      const restored = database(
        databaseUrl.replace(/\/vitalog$/, "/vitalog_restore"),
      );
      try {
        const restoredService = new Service(
          restored.db,
          "attachment-verification",
          storage,
        );
        const result = await restoredService.execute(
          "health_complete_attachment_upload",
          { id: imageId, idempotency_key: "image-completion" },
        );
        assert.equal(result.idempotent_replay, true);
        assert.equal(object(result.attachment).status, "ready");
        const link = await restoredService.execute("health_list_attachments", {
          record_id: nutritionId,
          record_version: 1,
        });
        assert.equal((link.attachments as Data[])[0]!.id, imageId);
      } finally {
        await restored.pool.end();
      }
      await connection!.pool.query(
        "update attachments set created_at=created_at - interval '1 day', upload_expires_at=upload_expires_at - interval '1 day'",
      );
      execFileSync(
        process.execPath,
        ["--import", "tsx", "scripts/attachments-prune.ts"],
        { env: operatorEnv, stdio: ["pipe", "pipe", "pipe"] },
      );
      await missingObject(`vitalog/uploads/${imageId}`);
      const states = await connection!.pool.query(
        "select status, upload_pruned_at from attachments",
      );
      assert(states.rows.every((row) => row.upload_pruned_at));
      assert(states.rows.some((row) => row.status === "expired"));
      assert(!states.rows.some((row) => row.status === "pending"));
      const retry = await rest(
        "/v1/attachments/uploads",
        fileMetadata(png),
        "image-reservation",
      );
      assert.equal(retry.status, 200);
      assert.equal(retry.body.upload, null);
      const failedRetry = await rest(
        "/v1/attachments/uploads",
        { ...fileMetadata(png), sha256: "0".repeat(64) },
        "wrong-checksum",
      );
      assert.equal(failedRetry.body.upload, null);
      assert.equal(
        (
          await rest(
            `/v1/attachments/${object(failedRetry.body.attachment).id}/complete`,
            {},
          )
        ).status,
        422,
      );
      await s3!.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: "unrelated/sentinel",
          Body: "keep",
        }),
      );
      await client!.close();
      client = undefined;
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/erase.ts",
          "--confirm-permanent-erasure=ERASE_VITALOG",
        ],
        { env: operatorEnv, stdio: ["pipe", "pipe", "pipe"] },
      );
      const remaining = await s3!.send(
        new ListObjectsV2Command({ Bucket: bucket }),
      );
      assert.deepEqual(
        remaining.Contents?.map((entry) => entry.Key),
        ["unrelated/sentinel"],
      );
      const databaseCounts = await connection!.pool.query(
        "select (select count(*) from attachments)::int files, (select count(*) from record_attachments)::int links, (select count(*) from attachment_idempotency_requests)::int retries, (select count(*) from health_records)::int records",
      );
      assert.deepEqual(databaseCounts.rows[0], {
        files: 0,
        links: 0,
        retries: 0,
        records: 0,
      });
    },
  );
  await mkdir(".test-artifacts", { recursive: true });
  await writeFile(
    ".test-artifacts/attachments.json",
    JSON.stringify(
      {
        executed_at: new Date().toISOString(),
        transport: "REST and generic MCP SDK client",
        database: "PostgreSQL 17.11",
        object_storage: "MinIO (Chainguard)",
        object_storage_image: minioImage,
        maximum_file_bytes: MAX_ATTACHMENT_BYTES,
        checks,
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(
    `PASS ${checks.length} attachment verification groups\n`,
  );
} finally {
  await client?.close();
  if (server)
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
      server!.closeAllConnections();
    });
  await connection?.pool.end();
  s3?.destroy();
  if (baselineFolder)
    await rm(baselineFolder, { recursive: true, force: true });
  for (const container of [postgresContainer, minioContainer]) {
    try {
      command(["rm", "-f", container]);
    } catch {
      /* This test container may already be gone. */
    }
  }
}
