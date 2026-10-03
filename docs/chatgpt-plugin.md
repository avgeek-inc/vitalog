# ChatGPT plugin

The distributable package is built from [`plugin/`](../plugin). Run `npm run plugin:package` to create `dist/vitalog-plugin.zip`. The script validates both manifests against the pinned Agent Plugins 1.0.0 schemas, verifies the transparent brand assets and every archive entry, and packages only six allowlisted files. CI uploads the zip alongside verification reports.

The archive uses root `plugin.json` and `mcp.json`, OpenAI presentation metadata, the Vitalog heart-and-plus mark, and one skill for using the ledger. It declares the Streamable HTTP endpoint `https://vitalog.praveent.com/mcp`. Authentication is implemented by the server; the archive contains no API keys, root credentials, OAuth codes or tokens.

## Connect after deployment

Your email and password still generate a 30-day API key. When you connect the plugin, Vitalog opens a page where you enter that key and approve ChatGPT's access. Vitalog then gives ChatGPT a separate connection token automatically. You do not have to create or copy that second token, and your root password stays with Vitalog. The connection keeps the key's original expiry; revoking the key also disconnects ChatGPT.

The extra connection step is needed because [ChatGPT's authenticated MCP connections use OAuth and cannot send custom API keys directly](https://developers.openai.com/plugins/build/auth). Vitalog handles this handshake using the API key you already generated.

1. Merge and deploy the follow-up changes. Startup applies migration `0003_remove_api_key_names` and `0004_chatgpt_oauth` before serving requests.
2. Generate a key at `https://vitalog.praveent.com/api-keys` using the existing configured email and password.
3. Upload `vitalog-plugin.zip` in ChatGPT's **New Plugin** dialog. Connect the declared MCP server with OAuth when prompted.
4. On Vitalog's **Connect ChatGPT** page, paste the generated key, review the requested access and select **Connect ChatGPT**. Credentials are sent only in the private Authorization header to Vitalog. The page clears the key after submission and when leaving the page.
5. Use the plugin to query or log the observations you supply. Reconnect with a new generated key when the linked key expires. Revoking that key or all generated keys blocks the connection on its next MCP request.

This is a package for personal upload. Public-directory submission has separate publisher, domain-verification and review requirements. No public publication or ChatGPT account installation is performed by packaging the archive.

## Issuer and authentication

`PUBLIC_BASE_URL` sets the exact canonical issuer origin without a trailing slash. It must be HTTPS and its host must appear in `ALLOWED_HOSTS`, allowing equivalent default ports. Loopback HTTP is permitted for local development. If the variable is empty and `ALLOWED_HOSTS` contains exactly one public DNS origin, the canonical issuer is inferred. For example, `vitalog.praveent.com:443` infers `https://vitalog.praveent.com`, while `:8443` remains in the issuer. Host-header validation retains the exact configured ingress values. The existing Towbar host list infers `https://vitalog.praveent.com`; no new production secret is needed. Multiple public origins require an explicit issuer. OAuth routes are disabled when no issuer is configured or inferred; existing API-key access remains available.

Vitalog serves protected resource metadata at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`, and authorization server metadata at `/.well-known/oauth-authorization-server`. An unauthenticated `/mcp` response advertises the resource metadata in `WWW-Authenticate`.

The authorization server accepts ChatGPT's stable Client ID Metadata Document at `https://chatgpt.com/oauth/client.json`. It fetches only that exact HTTPS URL, rejects redirects, limits the response to 8 KiB with a five-second timeout, verifies the advertised public-client method and exact callback, and caches successful validation for ten minutes. Other client URLs, DCR and non-ChatGPT callbacks are not supported. The callback is `https://chatgpt.com/connector_platform_oauth_redirect`. Successful and denied consent responses include the exact issuer in `iss` and preserve `state`. Authorization errors for that exact client and callback also return there with `error`, `iss` and the original valid `state`; unknown or ambiguous client/callback values stay local. An error clears the pending flow cookie and never issues a code.

Authorization requires S256 PKCE, an exact `resource=<issuer>/mcp` and explicit consent using an active generated API key. `AUTH_KEY` cannot approve a connection. A signed HttpOnly SameSite=Lax flow cookie expires after five minutes; HTTPS cookies use the Secure flag and `__Secure-` prefix. Approval requires the exact issuer Origin and matching CSRF token. It accepts JSON only, permits five attempts per address and thirty per process per minute, and returns `Retry-After: 60` when limited. Authentication bodies are bounded to 4 KiB.

Codes expire after five minutes and are stored only as hashes. Exchange uses form-encoded `authorization_code`, with exact client, callback, resource and PKCE binding. A PostgreSQL transaction locks and consumes a code once; concurrent exchanges cannot issue two tokens. There is no implicit, password, client-secret or refresh grant. Issuance, exchange and OAuth authentication trigger cleanup at most once per process per minute, sharing concurrent cleanup work. Each batch deletes up to 1,000 codes and 1,000 tokens whose own lifetime or parent key has expired or whose parent was revoked, skipping locked grants. Additional batches run on subsequent OAuth traffic; cleanup leaves API-key metadata, active grants and health records intact.

OAuth access tokens use a separate `vlo_` prefix and 32 random bytes, are stored only as SHA-256 hashes, and link to the existing API-key ID. Their expiry is the parent's original expiry, never a new 30-day period. The MCP resource checks token audience, token and parent expiry, parent revocation and scopes on every request. OAuth tokens grant MCP access only; they cannot access REST or key administration. API keys retain their existing REST/MCP behavior and the primary environment key retains exclusive key administration.

`health:read` permits read tools and `health:write` permits mutation tools. Each tool advertises its required OAuth scope. Missing permissions return an MCP OAuth challenge without executing the operation. Tokens and authorizations survive server restarts; expiry and revocation have no application cache. Primary-key rotation preserves issued access tokens but invalidates pending signed browser consent cookies. Restoring an older backup can also restore a previously revoked connection; revoke restored keys before exposing a restored database.

## Verification

Run `npm run verify`, `npm run test:auth` and `npm run test:oauth`. The OAuth command creates and removes a disposable PostgreSQL 17 database and tests both the actual Hono routes and the official MCP client. It covers PKCE and audience binding, one-time/concurrent code exchange, cookie/CSRF/origin protection, hash-only storage, permission enforcement, expiry, restart, parent-key revocation/revoke-all, bounded attempts/bodies, untrusted client metadata and log privacy. Client metadata uses a deterministic fixture matching the published ChatGPT CIMD document; this is not proof of a live ChatGPT account link. The ignored report is `.test-artifacts/oauth.json`.

The package format follows [OpenAI's plugin packaging documentation](https://developers.openai.com/plugins/build/plugins). The flow follows its [MCP authentication documentation](https://developers.openai.com/plugins/build/auth). Packaging and local protocol checks do not verify a production deployment or a successful ChatGPT upload; those must be checked after merge and deployment.
