# Deploy with Towbar

The repository declares a `production` environment in [towbar.yml](../towbar.yml), a [PostgreSQL datastore](../.towbar/datastores/vitalog-postgres.datastore.yml), and a [Vitalog Dockerfile service](../.towbar/services/vitalog.service.yml). Both workloads and the image build target **Praveen Apps**, `13.204.184.47`. Vitalog's public hostname is **vitalog.praveent.com**.

The server is an ARM64 `t4g.small` with two CPUs and about 2 GiB of RAM. The API has a 512 MiB limit and PostgreSQL has a 256 MiB limit, each capped at 0.5 CPU. Image builds use one CPU and 512 MiB. PostgreSQL uses 64 MiB shared buffers, up to 30 connections, 4 MiB work memory and 32 MiB maintenance memory. Vitalog's pool has five connections. Check live server capacity before deployment or increasing these limits.

## Connect and configure

1. Merge the Towbar configuration into `main`, connect the private GitHub repository in Towbar, and map `production` to `main`.
2. Sync the repository. This creates desired configuration; it does not start either workload. Both files disable automatic deployment so the database can be initialized before the API.
3. Save the following production runtime values under **Vitalog PostgreSQL → Settings → Secrets**:

| Key                 | Value                                                         |
| ------------------- | ------------------------------------------------------------- |
| `POSTGRES_USER`     | `vitalog`                                                     |
| `POSTGRES_DB`       | `vitalog`                                                     |
| `POSTGRES_PASSWORD` | A new password supplied through the operator's secret manager |

Save these production runtime values under **Vitalog → Settings → Secrets**:

| Key             | Value                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| `AUTH_KEY`      | An operator-created secret from at least 32 random bytes, using the encoding documented in the README |
| `DATABASE_URL`  | `postgresql://vitalog:<URL-encoded password>@vitalog-postgres:5432/vitalog`                           |
| `ALLOWED_HOSTS` | `vitalog.praveent.com,127.0.0.1:3000,vitalog:3000`                                                    |

The password in `DATABASE_URL` must match the datastore password. URL-encode it; a random hexadecimal password needs no escaping. Commit only the declared key names, never their values. Initialization variables apply only to a new PostgreSQL volume. Changing a saved password later also requires rotating it in PostgreSQL.

The image supplies production mode and port 3000. The default timezone is `Asia/Kolkata`. Forwarded client addresses remain untrusted by default; enable proxy trust only with the exact immediate peer addresses required by the README. Browser origins are optional and must be explicitly allowed through `ALLOWED_ORIGINS` when using a browser client.

## Deploy and verify

1. Deploy **Vitalog PostgreSQL** and wait for engine readiness. Towbar owns the persistent PostgreSQL volume. The datastore has no public domain or SSH-tunnel port.
2. Deploy **Vitalog**. The existing Dockerfile builds an ARM64 image, runs as UID 1000, and applies the checked-in Drizzle migrations before listening. A migration failure prevents startup.
3. Wait for Towbar's command readiness check. It calls `/readyz` inside the candidate with the runtime key and an allowed Host header, and fails if PostgreSQL is unavailable. The command contains key names, with values read from the container environment. It does not print credentials.
4. Towbar's enabled Cloudflare integration manages DNS and TLS for `vitalog.praveent.com`. Public routing exposes the API's port 3000 through the proxy. `/healthz` is the minimal public liveness probe; `/readyz`, `/v1`, `/mcp` and `/openapi.json` require authentication.
5. Verify HTTPS liveness, authenticated readiness, catalog discovery and an official MCP client connection. A new datastore is empty. Use synthetic writes only in a disposable environment; a production logging request changes the real ledger.
6. Configure encrypted backup storage, retention and restore drills using the [backup and erasure procedures](../README.md#export-backups-and-erasure) before storing real health data. No backup destination is invented by these manifests.

The service uses a recreate rollout for command readiness, with maintenance mode for its stable private network alias. Towbar stops the previous release before replacement. Requests can be briefly interrupted; retry an interrupted mutation with its original idempotency key. Deploying an older image does not reverse database migrations or restore erased records.

## Repository checks

```sh
npm run towbar:check
npm run test:towbar
```

`towbar:check` uses the pinned [official schemas](../schemas/towbar/README.md), checks environment and network references, and compiles the health command without executing it. Towbar performs the complete infrastructure validation on sync.

`test:towbar` starts disposable local Docker containers with the manifest's runtime limits, PostgreSQL image and tuning, network aliases and readiness command. It verifies REST/MCP durability, the public Host allowlist, database failure and recovery, and operational log privacy. The [checked-in report](towbar-report.json) records 18 passed checks. It does not connect the repository in Towbar, deploy to Praveen Apps, create DNS records or issue a certificate. Fresh reports are written to ignored `.test-artifacts/towbar.json`; CI uploads that report.
