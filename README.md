# Vitalog

Vitalog stores one person's supplied health observations in PostgreSQL. Hono serves `/v1` REST routes and one `/mcp` endpoint. Both interfaces call the same domain services, validators and transactions.

The service has eight record types and sixteen MCP tools. The registry contains 182 nutrient keys, 424 laboratory analyte keys in 30 discovery groups, and 110 measurement/study keys. The database starts empty. All examples and verification fixtures are synthetic.

## Run with Docker Compose

1. Copy `.env.example` to `.env`.
2. Set `AUTH_KEY` to an operator-created secret from at least 32 random bytes. Use a secret manager or a local cryptographic random generator outside the application. The accepted encoding is 43–512 characters using letters, digits, `.`, `_`, `~`, `+`, `/`, `=`, or `-`. Length checks cannot prove randomness.
3. Set `POSTGRES_PASSWORD`. A random hexadecimal password avoids URL escaping in the supplied Compose connection string.
4. Set `ALLOWED_HOSTS` to the exact HTTP host values your ingress forwards, including a port when present. Set `ALLOWED_ORIGINS` only for trusted browser origins. With the default loopback port, `localhost:3000,127.0.0.1:3000` works.
5. Run `docker compose up --build -d --wait`.

Compose runs the API and PostgreSQL 17.11. It publishes the API on `127.0.0.1:3000` and keeps PostgreSQL on the internal network. The API applies the checked-in Drizzle migrations before listening, runs as UID 1000, and has a read-only root filesystem. Each container has a 512 MiB memory limit and one CPU. The API has a 128-process limit and a 35-second shutdown allowance.

For production, put a TLS ingress in front of the loopback API. Forward its original Host header and configure that host in `ALLOWED_HOSTS`. Prevent direct public access to the container network and PostgreSQL. Keep ingress access logs free of Authorization, query strings containing secrets, request/response bodies and health data. The API rejects its configured key anywhere outside the Authorization header before domain validation, including record text, encoded property names, URLs and idempotency headers. Avoid request-body capture and health payload capture in tracing systems.

The default installation ignores forwarded client addresses. To trust one ingress, set `TRUST_PROXY=true` and exact `TRUSTED_PROXY_IPS` matching the API's immediate socket peer. The ingress must overwrite `X-Forwarded-For` with one validated client IP. Forwarded host/protocol values do not expand the host allowlist. CORS is not an authentication mechanism.

`GET /healthz` returns minimal unauthenticated liveness. `GET /readyz` requires the key and checks the migrated database without returning connection details. Missing credentials, a placeholder secret, invalid configuration or unapplied migrations prevent startup. All health responses use `Cache-Control: no-store`.

## Run with Towbar

For deployment on Praveen Apps with a managed PostgreSQL datastore and `vitalog.praveent.com`, follow [the Towbar deployment guide](docs/towbar-deployment.md). The version-2 manifests declare both workloads and their private network; runtime credentials are supplied in Towbar.

## Run from source

Use Node.js 24.16.0 and npm 11.13.0. Dependency versions and transitive dependencies are locked in `package-lock.json`.

```sh
npm ci
npm run db:migrate
npm run dev
```

The development and migration commands load `.env` if present. `DATABASE_URL` must address PostgreSQL. `DEFAULT_TIMEZONE` defaults to `Asia/Kolkata`; `PORT` defaults to `3000`. A production process uses `npm run build` followed by `npm start` with environment variables supplied by the deployment. Apply migrations before starting it. The Docker entrypoint performs both steps.

The API-key page uses React 19, HeroUI v3 and Tailwind CSS v4, following Towbar's component setup. Vite builds its JavaScript, CSS and Inter font into `dist/web`; Hono serves them from the same origin. `npm run dev` builds the page before starting the API. Run `npm run dev:web` in another terminal to rebuild it as you edit. `npm run build` and the Docker build include both API and UI assets.

Generate new database migrations with `npm run db:generate`. Apply them with `npm run db:migrate`. The migration runner serializes concurrent migration attempts with a PostgreSQL advisory lock. Keep deployed migration files immutable and add forward migrations for later changes. Never use `drizzle-kit push` as a production upgrade procedure.

## Authentication

Every `/v1/*`, `/mcp`, `/readyz` and `/openapi.json` request requires an HTTP Bearer key. The environment `AUTH_KEY` has full ledger access and exclusive API-key administration. Manually generated `vlk_` keys have full ledger access for exactly 30 days unless revoked, and cannot list or revoke keys. ChatGPT's `vlo_` OAuth tokens authorize only their requested MCP scopes for 30 days. MCP initialization, discovery, calls and transport operations all require the same Bearer header. This remains one person's ledger; a key does not create a separate user or datastore.

Set `ROOT_EMAIL` and `ROOT_PASSWORD` to enable generation at `/api-keys` and sign-in for ChatGPT's OAuth connection. The password must contain at least 15 non-padding characters and fit within 256 UTF-8 bytes, and must differ from `AUTH_KEY`. Configure both values together; leaving both empty disables issuance and sign-in while existing Bearer clients keep working. Root email matching ignores surrounding whitespace and case; password matching is exact. Root credentials authenticate issuance and OAuth consent, and cannot authenticate ledger requests directly. The API verifies the password using salted scrypt with bounded concurrency and shared rate limits.

The page submits root credentials to `POST /auth/api-keys` over HTTPS (loopback HTTP is supported for development). It shows the complete token once and clears the password after submission. Tokens use 32 random bytes and are stored only as SHA-256 hashes in PostgreSQL. They are opaque, not JWTs. Every authenticated request checks expiry and revocation using the database clock; a revoke affects subsequent requests, including requests from an existing MCP client. Requests already authenticated may complete.

The primary key manages generated keys and OAuth connection records through `GET /v1/api-keys`, `DELETE /v1/api-keys/{id}`, and `DELETE /v1/api-keys`. Listing is paginated and returns short token hints, timestamps and status, never token values or hashes. Revoke-all also cancels pending OAuth authorization codes; it leaves `AUTH_KEY` valid and does not prevent new issuance with the root credentials. Root email/password cannot revoke keys. There are no key-management MCP tools; the MCP surface remains sixteen tools.

See [API-key setup and contracts](docs/api-keys.md) for request examples and operational behavior. These features extend the original specification's authentication exclusions. The [ChatGPT plugin](docs/chatgpt-plugin.md) uses OAuth discovery and authorization-code exchange with S256 PKCE. Sign in on Vitalog's consent page with your root email and password; ChatGPT receives its token automatically without requiring the API-key generation page. The token is created only at code exchange and has a revocable management record in the same API-key list.

To rotate `AUTH_KEY`, replace the deployment secret, restart the API, and update each trusted client's private header configuration. Generated keys, database idempotency and history survive rotation. Signed ledger pagination cursors use a digest-derived signing key, so clients restart pagination after key rotation. Changing root credentials affects future issuance and does not revoke generated keys; use the revoke-all API when that is intended.

The default request limit is 1 MiB. Domain responses and discovery responses are bounded to 8 MiB. Requests have a 25-second application deadline, a 30-second HTTP request timeout, and a 15-second PostgreSQL statement timeout. If a mutation response is lost or times out, retry with its original idempotency key. A committed write may outlive an interrupted response. `RATE_LIMIT_PER_MINUTE` defaults to 600 per socket/client address. Read queries have explicit record, date and page limits described in [the integration guide](docs/integration.md).

Operational logs contain event, method, status and elapsed time. They omit route parameters, credentials, health bodies, tool arguments and database parameters. Docker log rotation is bounded to three 10 MiB files.

## Use the interfaces

Start discovery with authenticated `GET /v1/catalog` or `health_get_catalog({})`. Use an exact record schema lookup before an unfamiliar write, for example `/v1/catalog?category=record_schemas&key=nutrition&include_schema=true`. The catalog depends on code definitions, not existing health records.

The [integration guide](docs/integration.md) describes all REST/MCP mappings, filtering, dates, provenance, result variants, summaries and retries. [OpenAPI JSON](docs/openapi.json), [complete record schemas](docs/record-schemas.json) and [executable examples](docs/examples.json) are generated from the shared definitions.

[Postman instructions](postman/README.md) cover the Native Git workspace layout used by Towbar and the importable v2.1 JSON collection. The collection contains 49 requests across REST, technical endpoints, MCP initialization, tool discovery, all sixteen tools, API-key generation/administration and OAuth. Secret values are blank in the repository.

Run `npm run plugin:package` to build `dist/vitalog-plugin.zip` for ChatGPT upload. The [plugin guide](docs/chatgpt-plugin.md) covers deployment and linking an existing generated key through OAuth. The connection expires with its key and is revoked through the same API-key management APIs. The archive includes the [Vitalog mark](docs/branding.md) and contains no credentials.

## Verify a change

```sh
npm run verify
npm run test:integration
npm run test:security
npm run test:auth
npm run test:oauth
npm run test:summaries
npm run test:container
npm run test:towbar
npm run build
npm audit --omit=dev --audit-level=moderate
```

`verify` runs type checks, unit/schema tests, generated-artifact checks and formatting. The PostgreSQL integration command creates a disposable Docker database, exercises the official MCP client and REST, and removes that database. Separate security and summary checks verify that credentials cannot be stored or reflected and that historical studies do not exhaust unrelated read windows. The container command starts an isolated Compose project, tests the production image, and removes that project's containers and volumes. All commands use synthetic records and generated test credentials confined to their processes.

[The acceptance traceability](docs/acceptance.md) maps all 76 requirements to implementation and verification. [The coverage report](docs/coverage.json) lists every implemented key and its tests. [The verification report](docs/verification-report.json) records the executed interoperability run, exact SDK/protocol/client versions, and database backup/restore result. [The container report](docs/container-report.json), [security report](docs/security-report.json) and [summary report](docs/summary-report.json) record the additional deployment checks. Current runs write their reports to ignored `.test-artifacts/`; they do not rewrite checked-in evidence automatically.

The GitHub verification workflow runs these checks on pushes and pull requests. A separate tag workflow verifies the repository and publishes `ghcr.io/avgeek-inc/vitalog:<tag>` for a pushed `v*` tag. Publishing an image does not deploy a server. There are no production credentials checked into this repository.

## Export, backups and erasure

The operator export streams a consistent, read-only snapshot as JSON Lines to stdout. It includes records, immutable revisions and idempotency metadata. The command accepts no output path; the operator controls redirection and access permissions.

```sh
npm run --silent operator:export > vitalog-export.jsonl
# In the production image:
docker compose exec -T api node dist/scripts/export.js > vitalog-export.jsonl
```

Store exports as private health data. `.gitignore` excludes database dumps and JSON Lines exports, but it cannot protect files copied outside this repository. Do not commit exports.

For a streaming PostgreSQL backup and a restore into a fresh database:

```sh
docker compose exec -T postgres pg_dump -U vitalog -d vitalog --format=custom > vitalog.dump
# Configure an empty destination and stop its API before restoring.
docker compose exec -T postgres pg_restore -U vitalog -d vitalog --no-owner --no-privileges < vitalog.dump
```

A real backup/restore test is part of integration verification. It compares all restored record, revision and idempotency values, retrieves immutable history, and replays committed creation, correction and void requests without new rows. Choose an encrypted backup location, a retention period and a restore drill cadence through the deployment's infrastructure. Backups include revisions and idempotency data. A restored older backup may resurrect corrected or erased observations and may lack newer retry keys. Review the backup date before allowing writes after a restore.

Voiding preserves history and removes a record from effective calculations. Permanent erasure is an operator operation. Stop the API, confirm the intended database, and run:

```sh
npm run operator:erase -- --confirm-permanent-erasure=ERASE_VITALOG
# In the production image:
docker compose run --rm --no-deps api node dist/scripts/erase.js --confirm-permanent-erasure=ERASE_VITALOG
```

The erasure transaction truncates records, revisions and idempotency metadata. It keeps the database schema. For complete operational erasure, also remove exports, expired backups, snapshots and any accidental sensitive logs or traces. Database truncation does not erase copies in retained backups, WAL archives or storage snapshots. Follow the storage provider's deletion and retention policy. Do not resume from an older backup without applying the same erasure decision.

## Definition and version policy

The current catalog version is `1.0.1`. It retains the initial `1.0.0` identifiers while adding precise field conditions and shared per-key input constraints. REST `/v1`, MCP negotiation, record schema versions and record revision numbers are separate. Record schema version 1 represents preserved legacy snapshot semantics; version 2 is the revision-5 contract. Stored version-2 data keeps its original typed shape, while fresh writes and corrections use the current input schemas. Existing broad nutrient names keep their supplied or unknown definition. `upgradeSnapshot` makes an explicit lossless copy and does not add measurements, nutrient bases or clinical identity. Current writes use version 2. Historical snapshots and committed retries are read without fresh-event clock validation.

The embedded inventory was supplied with [specification revision 5](docs/specification.md). Its research/source register is preserved there. Registry identifiers are application keys. No unverified LOINC/UCUM crosswalk or clinical reference intervals are installed. The code stores original units, reference information, source statuses and context rather than guessing assay equivalence. The chosen [official TypeScript MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x) is pinned to `1.31.0`; its tested protocol revision is recorded in the verification report.
