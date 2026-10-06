# Deploy with Towbar

The repository declares a production environment in [towbar.yml](../towbar.yml), the existing [PostgreSQL datastore](../.towbar/datastores/vitalog-postgres.datastore.yml), the [Hono API](../.towbar/services/vitalog.service.yml), and a separate [Next.js UI](../.towbar/services/vitalog-web.service.yml). All three workloads and image builds target **Praveen Apps**, `13.204.184.47`.

| Service            | Public address                     | Build                         | Runtime limit    |
| ------------------ | ---------------------------------- | ----------------------------- | ---------------- |
| Vitalog UI         | `https://vitalog.praveent.com`     | `apps/web/Dockerfile`         | 256 MiB, 0.5 CPU |
| Vitalog API        | `https://vitalog-api.praveent.com` | `Dockerfile`                  | 512 MiB, 0.5 CPU |
| Vitalog PostgreSQL | Private network only               | Pinned PostgreSQL 17.11 image | 256 MiB, 0.5 CPU |

The API emits JavaScript separately from CI type checking. The UI uses webpack with memory optimizations and one build worker, retaining its TypeScript build check. Selective HeroUI and React Aria imports reduce the build's dependency graph, and the Next.js build command caps its V8 heap at 384 MiB; the runtime does not inherit that cap. Builds run one at a time: the API build has 512 MiB and the Next.js build has 768 MiB. The API retains its manifest ID `vitalog` and private network alias; PostgreSQL retains `vitalog-postgres`, its existing workload and persistent volume. The UI has no database connection and requires no private API alias. PostgreSQL uses 64 MiB shared buffers and at most 30 connections; the API pool uses five.

## Runtime configuration

Keep existing API `AUTH_KEY`, `ROOT_EMAIL`, `ROOT_PASSWORD` and `DATABASE_URL` values. Update only public routing configuration, and add the two non-sensitive origins to the UI. The UI has no root credentials, primary token or database password.

| API runtime key   | Value                                                         |
| ----------------- | ------------------------------------------------------------- |
| `AUTH_KEY`        | Existing operator-created primary token                       |
| `ROOT_EMAIL`      | Existing root email                                           |
| `ROOT_PASSWORD`   | Existing root password                                        |
| `DATABASE_URL`    | Existing private PostgreSQL URL using `vitalog-postgres:5432` |
| `ALLOWED_HOSTS`   | `vitalog-api.praveent.com,127.0.0.1:3000,vitalog:3000`        |
| `PUBLIC_BASE_URL` | `https://vitalog-api.praveent.com`                            |
| `UI_BASE_URL`     | `https://vitalog.praveent.com`                                |

| UI runtime key | Value                              |
| -------------- | ---------------------------------- |
| `API_BASE_URL` | `https://vitalog-api.praveent.com` |
| `UI_BASE_URL`  | `https://vitalog.praveent.com`     |

The existing datastore bindings remain `POSTGRES_USER`, `POSTGRES_DB` and `POSTGRES_PASSWORD`. Do not replace the volume or rotate database credentials to perform this split. The application applies forward Drizzle migrations before serving traffic, including the OAuth migrations already in this branch.

## Rollout

1. Merge the verified change and sync the source's production environment on `main`. Inspect the successful immutable sync and confirm it declares all three workloads.
2. Set the API public origins/host list and UI runtime origins using the current secret-slot revisions. Preserve existing credential bindings.
3. Deploy the API first. Its successful rollout moves ingress from `vitalog.praveent.com` to `vitalog-api.praveent.com` and removes the old route. The API uses a singleton recreate rollout with authenticated database readiness; expect a brief interruption during this step.
4. Deploy the UI to claim `vitalog.praveent.com`. Towbar's Cloudflare integration provisions DNS and TLS for both domains. The UI checks `/healthz`, which validates its runtime origin configuration. Its stateless rollout does not require the database.
5. Inspect both deployment IDs to terminal success. Verify public TLS and `/healthz` on each domain; inspect API OAuth discovery and unauthenticated MCP challenges; render `/api-keys` on the UI. Check both workload runtime states and operational logs.
6. Update REST clients and upload the rebuilt plugin using `https://vitalog-api.praveent.com/mcp`. Reconnect existing OAuth connections: changing the resource host changes their audience. Existing manual API keys, ledger records and database history are preserved.

The brief gap between API route migration and UI promotion is intentional. A rollback must restore the previous API public configuration and free the UI hostname before an older API release can reclaim it. Rolling back application code does not undo committed Drizzle migrations.

## Verification

```sh
npm run towbar:check
npm run test:container
npm run test:towbar
npm run test:build-budget
```

`towbar:check` validates all three manifests against pinned official schemas, domain separation, the UI's credential-free runtime keys, private database network and Dockerfile paths. `test:container` runs production API/UI images as separate non-root containers with read-only filesystems. It verifies real Next.js routes and local assets, script nonces/CSP, absence of API credentials in the UI, exact-origin preflight, generated-key use/revocation, migrated database readiness and REST/MCP durability. `test:towbar` repeats this with the manifests' resource limits, PostgreSQL image/tuning, aliases and readiness command, including database failure and recovery.

`test:build-budget` installs and runs each production build in an isolated container using the manifest's architecture, memory and CPU limits, with swap disabled. It records the cgroup's peak memory when available, including reclaimable file cache. CI and tag publication run on native ARM64 runners to match Praveen Apps and require this check. It catches builder OOM failures that runtime container checks cannot detect; full API/UI type checking remains a separate required gate.

Fresh reports are written to ignored `.test-artifacts/` and uploaded by CI. Historical checked-in container/Towbar reports describe the earlier single-service run; they do not prove this split, a production deployment, DNS/TLS, or a successful ChatGPT account connection.
