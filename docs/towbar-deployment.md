# Deploy with Towbar

Run Vitalog as three workloads: PostgreSQL, the Hono API and the Next.js web app. The checked-in [Towbar environment](../towbar.yml), [datastore](../.towbar/datastores/vitalog-postgres.datastore.yml), [API](../.towbar/services/vitalog.service.yml) and [web](../.towbar/services/vitalog-web.service.yml) manifests show the architecture. They contain deployment-specific server IDs and domains: customize them for your workspace before syncing. The example origins below are placeholders, not hosted Vitalog endpoints.

## Prepare your workspace

Connect your fork or checkout to Towbar and select a server you control. Replace the server references, service domains and any workspace-specific IDs in the manifests. Keep the API and UI on separate HTTPS origins, such as `https://vitalog-api.example.com` and `https://vitalog.example.com`. Keep PostgreSQL on the private workload network.

The API uses `Dockerfile`; the web app uses `apps/web/Dockerfile`. Build and deploy both from the same reviewed revision. The manifests bound build and runtime resources independently; ensure your server has enough available memory for image builds and PostgreSQL.

## Configure the API

Supply `DATABASE_URL`, `AUTH_KEY`, `ROOT_EMAIL` and `ROOT_PASSWORD` through Towbar runtime secrets. Bind the database URL to your private datastore hostname. Use independent, high-entropy credentials.

```dotenv
PUBLIC_BASE_URL=https://vitalog-api.example.com
UI_BASE_URL=https://vitalog.example.com
ALLOWED_HOSTS=vitalog-api.example.com,127.0.0.1:3000,vitalog:3000
```

Replace `vitalog:3000` with your actual private API alias when it differs. See [configuration](https://www.vitalog.dev/configuration) for trusted proxies, client origins and optional private attachment storage. Declare enabled S3 variables in the API manifest's runtime secret list.

## Configure the web app

```dotenv
API_BASE_URL=https://vitalog-api.example.com
UI_BASE_URL=https://vitalog.example.com
```

The public documentation defaults to `https://www.vitalog.dev`. `DOCS_BASE_URL` can override it for your own docs fork. Add that optional name to the web manifest's runtime secrets when setting an override. `API_INTERNAL_BASE_URL` can route server-side reads through a private API alias; it never reaches browser components.

The web app must not receive the primary key, root password or database credentials.

## Deploy and verify

1. Sync your customized production environment and review the resulting workloads before deploying.
2. Deploy PostgreSQL and wait for it to become ready. Preserve its volume on later upgrades.
3. Deploy the API. Its startup command applies forward Drizzle migrations before serving requests; authenticated readiness checks validate the database and schema.
4. Deploy the web app. Configure TLS ingress and DNS for both public origins using your Towbar installation's domain provider.
5. Check each deployment reaches terminal success. Test both `/healthz` routes, API OAuth discovery and the UI sign-in page through their public HTTPS origins.
6. Sign in, connect an MCP client and log a sample observation. Confirm it appears in Daily View, then verify key revocation rejects subsequent requests.

Take a tested PostgreSQL and attachment backup before upgrades. Deploy API and UI from the same release; rolling back code does not roll back migrations. Changing public API origins changes OAuth audiences and requires clients to reconnect. See [operations](https://www.vitalog.dev/operations).

## Repository checks

```sh
npm run towbar:check
npm run test:container
npm run test:towbar
npm run test:build-budget
```

These checks validate manifests and disposable production containers, including private networking, migrations, REST/MCP access and resource-limited builds. Local checks do not prove your chosen server, DNS or client connection is working; verify the deployed installation separately.
