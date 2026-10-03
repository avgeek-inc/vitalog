# API keys

Vitalog has one primary environment `AUTH_KEY` and optional generated API keys. Every key can read and write the single health ledger. Only `AUTH_KEY` can list or revoke generated keys. Key-management operations are REST-only and do not add MCP tools.

This is the authentication extension requested on 3 October 2026. It supersedes the original specification's prohibition on key generation/management. The [ChatGPT plugin](chatgpt-plugin.md) adds OAuth connections linked to existing generated keys. There are no additional accounts, JWTs, refresh tokens or health-ledger owners.

## Configuration and generation

Configure `ROOT_EMAIL` and `ROOT_PASSWORD` through your deployment's secret manager. Use at least 15 non-padding characters for the password, at most 256 UTF-8 bytes, and a different value from `AUTH_KEY`. Both values must be supplied together. Leave both empty to disable generation; existing primary and generated Bearer keys still work. Changing root credentials requires an API restart and affects new issuance only.

Open `https://vitalog.praveent.com/api-keys` after deploying this change, or the same path on your development instance. Enter the root email and password. The form sends a JSON POST and returns one token. Copy it immediately; it cannot be retrieved later. The password is cleared after submission, and neither credentials nor tokens are stored in browser storage. The page has no third-party assets, cannot be framed and uses a restrictive CSP and `Cache-Control: no-store`.

The page uses React 19 and HeroUI v3's accessible form, input, card and button components, with Tailwind CSS v4 and the locally bundled Inter font used in Towbar. Vite bundles everything at build time. Hono serves the HTML at `/api-keys` and the compiled assets under `/api-key-ui/assets/` from the same Docker image. No additional server or CDN is needed. The CSP permits same-origin scripts, styles, fonts and API requests; inline scripts/styles, native form submissions and framing remain blocked. The production build contains no root credentials or environment secrets.

Direct generation uses `POST /auth/api-keys` with `Content-Type: application/json`. This route authenticates using the JSON credentials and requires no Bearer header:

```json
{
  "email": "<configured root email>",
  "password": "<configured root password>"
}
```

Only `email` and `password` are accepted. The client cannot select a key name, expiry or privileges. Requests are limited to 4 KiB. Invalid email/password pairs return the same 401 response. Issuance permits five attempts per socket/trusted client address per minute, thirty total per process per minute and at most two concurrent password verifications. Limits include successful issuance. Untrusted forwarded IP headers do not change the bucket. A 429 includes `Retry-After: 60`; limits reset after process restart.

Email matching is case insensitive and ignores surrounding whitespace; password matching is exact. The API derives a salted scrypt verifier at startup (`N=32768`, `r=8`, `p=3`) and performs asynchronous verification. Root credentials are not stored in PostgreSQL. The token contains 32 random bytes under the `vlk_` prefix and is stored only as a SHA-256 hash. Its lifetime is exactly 720 hours, independent of timezone or daylight-saving transitions.

A successful 201 response contains `api_key`, `id`, `token_hint`, `created_at`, `expires_at`, `revoked_at` and `status`. Timestamps are UTC ISO strings. The `api_key` field occurs only in this creation response. Metadata status is `active`, `expired` or `revoked`; revocation takes precedence over expiration. Migration `0003_remove_api_key_names` drops the former name column and constraint; existing token hashes, IDs, expiry and revocation are preserved.

The generation endpoint accepts same-origin browser submissions from its HTTPS host, or loopback HTTP during development. Cross-origin submissions and form-encoded requests are rejected. Do not put root credentials in URLs or HTTP Basic authentication. Keep reverse-proxy request/response bodies and Authorization headers out of logging and tracing.

## Use and management

Supply `Authorization: Bearer <generated key>` privately on every REST or MCP request, including initialization and discovery. Active generated keys can use all existing ledger operations, readiness and the OpenAPI document. Expired, revoked, unknown and malformed keys return 401. Generated keys attempting administration return 403. A revoked key is rejected on the next request, even from an already connected MCP client; previously authenticated requests may complete.

Use the primary environment `AUTH_KEY` for these administration APIs:

| Method and path                      | Result                                                      |
| ------------------------------------ | ----------------------------------------------------------- |
| `GET /v1/api-keys?limit=50&offset=0` | `api_keys`, `total`, `limit`, `offset`; metadata only       |
| `DELETE /v1/api-keys/{id}`           | The key's metadata with `status=revoked`                    |
| `DELETE /v1/api-keys`                | `revoked_count` for all previously unrevoked generated keys |

Listing defaults to 50 rows and accepts a limit from 1 to 100 and offset from 0 to 1000000. It orders newest creation first, breaking ties by ID. Duplicate or unknown query parameters are rejected. Revocation accepts no request body or query. A missing key ID returns 404; repeating revocation preserves the original revocation timestamp. Revoke-all includes expired keys, is safe to repeat, and never changes `AUTH_KEY`. Keys created after revoke-all can be used normally. Metadata is retained for expired and revoked keys.

All state survives process restarts and primary-key rotation. No authentication cache delays revocation. Root credential changes do not implicitly revoke keys. Database backups include token hashes and revocation metadata; restoring an older backup can re-enable a key revoked after that backup. Use the primary key to revoke restored generated keys before exposing a restored instance.

These are bearer API keys. ChatGPT connects through the [OAuth flow](chatgpt-plugin.md) using an existing generated key. The connection receives a separate MCP token with the key's remaining lifetime, and revoking the linked key also revokes the connection.

## Verification

Run `npm run build:web` before the standalone `npm run test:auth` command, or run `npm run verify` first. The auth check creates and removes a disposable PostgreSQL database. It verifies the compiled page and its same-origin assets, a populated-database forward migration, one-time issuance and hash-only storage, both transports, administration boundaries, exact expiry, revocation, restart/rotation durability, login limits, origin protection, configuration fallback and log privacy. Reports are written to ignored `.test-artifacts/auth.json` and uploaded by CI. No production database is used.
