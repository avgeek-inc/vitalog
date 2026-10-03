# MCP OAuth

Vitalog's HTTP MCP resource implements the [MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) and its [client-registration mechanisms](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration). The implementation targets these authorization requirements independently of any client brand. Streamable HTTP transport and protocol negotiation use the pinned official TypeScript SDK 1.31.0, whose latest supported wire revision is `2025-11-25`; adding current OAuth mechanisms does not advertise a newer transport revision.

Connect clients to `https://vitalog-api.praveent.com/mcp`. The UI at `https://vitalog.praveent.com/oauth/authorize` is a consent screen reached through authorization, not the MCP endpoint. It displays the validated client's name, its metadata hostname when available, its callback destination and requested permissions. The page signs in with root email/password directly and never requires a previously generated API key.

## Discovery and client identity

Unauthenticated MCP requests return HTTP 401 with a `WWW-Authenticate` challenge pointing to `/.well-known/oauth-protected-resource/mcp`. The resource document declares its exact audience, authorization server, scopes and header-based bearer authentication. `/.well-known/oauth-authorization-server` advertises the issuer, authorization/token/registration endpoints, S256, supported client authentication and `client_id_metadata_document_supported=true`.

Client resolution uses these mechanisms in order:

1. A client explicitly configured through `OAUTH_CLIENTS`.
2. A persistent client ID previously issued by `POST /oauth/register`.
3. A public HTTPS Client ID Metadata Document (CIMD), with the document URL as `client_id`.

CIMD is the preferred discovery mechanism. The document must include an exactly matching `client_id`, `client_name` and `redirect_uris`. Public CIMD clients use `token_endpoint_auth_method=none`. Optional metadata is ignored; unsupported grants, scopes or authentication methods fail validation. Symmetric client secrets are never accepted from a public metadata document. `private_key_jwt` clients publish a public `jwks` or `jwks_uri` and can use RS256, PS256 or ES256 assertions. Client capability metadata may also list refresh-token support; Vitalog accepts authorization-code usage and does not issue refresh tokens.

Metadata requests have a five-second deadline and 5 KiB body limit, validate TLS, reject redirects, and require JSON. URLs must have an HTTPS path and cannot contain credentials, fragments or dot segments. DNS must resolve only to public addresses; the outgoing connection is pinned to those validated addresses to prevent rebinding. Private, loopback, link-local, reserved and mapped addresses are rejected. Only validated documents are cached: cache headers and Age/Expires are respected, caching is capped at ten minutes, absent cache headers use five minutes, and no-store/no-cache prevent reuse. The cache holds at most 100 documents and at most 32 client document fetches run concurrently, including JWKS requests.

## Configured and dynamic clients

`OAUTH_CLIENTS` is an optional JSON array with at most 20 unique clients. Leave it as `[]` when using CIMD or dynamic registration. A public native-client example is:

Docker Compose passes this variable from the root `.env` to the API only. For configured clients on Towbar, add `OAUTH_CLIENTS` to the API workload's `secrets.runtime` list and supply its JSON through Towbar before syncing that manifest. Browser MCP clients likewise need `ALLOWED_ORIGINS` supplied to the API runtime. CIMD and dynamic registration work with the checked-in Towbar manifest without extra client secrets.

```json
[
  {
    "client_id": "example-native-client",
    "client_name": "Example MCP client",
    "redirect_uris": ["com.example.client:/oauth/callback"],
    "token_endpoint_auth_method": "none",
    "scope": "health:read"
  }
]
```

A client using shared-secret authentication uses `client_secret_basic` or `client_secret_post` and a separately generated `client_secret` with 43–512 allowed secret characters. Keep the JSON in the deployment's secret manager. Secrets must differ from the root password and primary key; only their SHA-256 digests enter client configuration used for authentication. Generated and configured client secrets cannot be stored or reflected in health data.

For clients without CIMD or prior registration, send an unauthenticated JSON POST to `/oauth/register`:

```json
{
  "client_name": "Example MCP client",
  "redirect_uris": ["http://127.0.0.1:49152/callback"],
  "token_endpoint_auth_method": "none",
  "grant_types": ["authorization_code"],
  "response_types": ["code"],
  "scope": "health:read health:write"
}
```

HTTP 201 returns the accepted metadata, opaque `client_id` and `client_id_issued_at`. Omitting `token_endpoint_auth_method` defaults to `client_secret_basic`, following RFC 7591; public clients must explicitly request `none`. Confidential registrations receive a random `client_secret` once and `client_secret_expires_at=0`; PostgreSQL stores only its digest. Clients using `private_key_jwt` instead supply one public `jwks` or public HTTPS `jwks_uri` and receive no symmetric secret. Persist the ID and any secret privately in the client. Registration itself never issues a ledger token or grants access.

Clients survive API restarts. Dynamic registration has a separate limit of ten attempts per source IP per minute and a persistent capacity of 1,000 clients, enforced transactionally. Capacity exhaustion returns HTTP 503 `temporarily_unavailable`; existing, configured and CIMD clients continue to work. There is no dynamic client-management or automatic deletion API. These registration limits are additional to the general API request limit.

Callbacks use exact registered values. Literal IPv4/IPv6 loopback HTTP callbacks can vary only their port, following [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252); the actual selected callback is bound exactly to the code exchange. HTTPS callbacks, localhost callbacks and reverse-domain native schemes retain exact matching. Fragments, userinfo, remote plain HTTP callbacks and reserved OAuth response parameters are rejected.

## Authorization and exchange

`GET /oauth/authorize` requires `response_type=code`, resolved `client_id`, registered `redirect_uri`, the canonical MCP `resource`, S256 `code_challenge` and `code_challenge_method=S256`. `scope` defaults to both supported scopes and must be within the client's registered scopes. `state` is preserved when supplied; it is optional with PKCE. Duplicate parameters are rejected and unknown OAuth parameters are ignored.

Client and callback validation precedes any redirect. Errors for unknown clients or unregistered callbacks stay local. Once the callback is validated, authorization errors return there with `error`, issuer `iss` and valid state. A signed, HttpOnly, host-only, five-minute cookie carries the consent context; credentials and flow data are not sent to the UI in its URL. The UI reads `/oauth/request` and submits JSON to `/oauth/approve` with the cookie, CSRF token, action and root credentials. Cancellation does not require credentials and returns `access_denied` without creating a code or token. Invalid login shows the HeroUI “Invalid credentials” toast and clears the password.

Approval returns only a one-use, five-minute authorization code. `/oauth/token` accepts form-encoded `authorization_code`, the code, exact selected callback, canonical resource and PKCE verifier. Public clients send `client_id` without a secret. Confidential clients authenticate through their registered method: HTTP Basic uses form-encoded ID/secret fields before base64 encoding, and POST authentication uses `client_id` and `client_secret` in the form body. Mixing methods, omitting a required secret or using a different client's code fails.

Private-key JWT authentication sends `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer` and a signed `client_assertion` in the form body. Its `iss` and `sub` must exactly match `client_id`, and `aud` must be the issuer or token endpoint URL. Assertions require `iat`, `exp` and a unique `jti`, expire within five minutes, and are verified with the registered public keys and allowed algorithm. JWT assertion replay hashes are persisted in PostgreSQL, so replay remains blocked after restart. Remote JWKS uses the same TLS, SSRF, size, deadline and concurrency protections as metadata and is fetched afresh to honor key rotation. Private or symmetric keys, mixed authentication methods, invalid signatures and unsupported algorithms fail closed. Access tokens remain opaque rather than JWTs.

Code exchange locks the hashed code in a PostgreSQL transaction, creates one token and its API-key management record, and consumes the code exactly once. Concurrent exchanges cannot issue duplicate tokens; an insertion failure rolls back issuance and consumption. Successful and denied callbacks include the exact issuer in `iss`, which the UI validates along with the selected callback before navigating.

Tokens are opaque `vlo_` bearer values from 32 random bytes and are stored only as SHA-256 hashes. They last 30 days from exchange and authorize only `/mcp`, the exact resource audience and granted scopes. `health:read` permits reads and `health:write` permits mutations. Missing scope returns HTTP 403 with `WWW-Authenticate`, `insufficient_scope`, the required scope and resource metadata, without executing the tool. Tokens cannot access REST or key administration. There are no implicit, password, client-credentials or refresh-token grants.

Primary-key administration lists the token's `vlo_…` management record and can revoke it or all generated keys. Revoke-all also cancels pending codes. Audience, expiry, revocation and scopes are checked on each request without an authentication cache. Existing grants and management records are preserved by the additive client-registration migration. Expired/revoked grants are pruned in bounded batches; health records and key metadata remain intact. Root-credential rotation affects future login, while primary-key rotation also invalidates pending consent cookies. Restoring an old database backup can restore old revocation state; revoke restored keys before exposing the restored service.

## Browser origins and runtime

Set `PUBLIC_BASE_URL` to the canonical API origin, `UI_BASE_URL` to the consent UI origin, and both `ROOT_EMAIL` and `ROOT_PASSWORD` to enable sign-in. The UI receives only `API_BASE_URL` and `UI_BASE_URL`. The API and UI should use sibling HTTPS subdomains so the API's SameSite=Lax cookie can be sent by the UI. Loopback HTTP is supported for development. Root credentials remain on the API and share authentication limits with manual API-key generation.

`ALLOWED_ORIGINS` is an exact browser-origin allowlist for discovery, `/oauth/register`, `/oauth/token` and MCP. Preflights cover the advertised protocol headers, and allowed browsers can read the OAuth challenge on 401/403 responses. These routes do not expose cookies through CORS. Only `UI_BASE_URL` can submit browser consent with credentials; adding an MCP browser origin does not authorize it on `/oauth/request` or `/oauth/approve`. Native/desktop clients without an Origin header use the same protocol and need no browser-origin entry.

## Verification

Run `npm run verify` and `npm run test:oauth`. Unit tests cover address/URL validation, pinned DNS, document limits, callback substitution and secret configuration. The database-backed OAuth suite exercises both ChatGPT-shaped and independent CIMD fixtures, dynamic public/confidential registration, configured native clients, restart durability, client/authentication/callback binding, signed assertions and persistent replay protection, optional state, PKCE, CSRF, root sign-in, issuer/resource validation, CORS challenges, read/write permissions, concurrent exchange, transactional rollback, revocation, expiry, registration limits/capacity and log privacy. The official MCP SDK performs discovery, CIMD and dynamic registration, code exchange, initialization, tool listing and a tool call.

These tests use disposable PostgreSQL and synthetic credentials. Metadata fixtures allow deterministic security checks; local protocol and UI screenshots do not prove an external client's account connection. Production linking and deployment are separate checks after merge. The ChatGPT upload archive is described in [the plugin guide](chatgpt-plugin.md), and generated OpenAPI/Postman include the generic OAuth routes and registration example.
