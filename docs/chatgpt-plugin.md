# ChatGPT plugin

Run `npm run plugin:package` to build `dist/vitalog-plugin.zip`. The archive has root `plugin.json` and `mcp.json`, OpenAI presentation metadata, the Vitalog heart mark and one skill for using the health ledger. It declares `https://vitalog-api.praveent.com/mcp` and contains no credentials.

Upload the ZIP through ChatGPT's **New Plugin** dialog and connect using OAuth. Vitalog resolves the client's metadata and shows **Connect ChatGPT** when its validated `client_name` is ChatGPT. Enter the configured root email and password, review the permissions and callback destination, then approve. The callback carries a short-lived code, state when supplied, and the issuer. ChatGPT exchanges the code and its S256 PKCE verifier privately for a revocable 30-day MCP token. Root credentials stay with Vitalog.

The MCP server uses the [MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization); it does not identify clients from a fixed ChatGPT name or callback. ChatGPT's `https://chatgpt.com/oauth/client.json` is one Client ID Metadata Document. Other clients can use their own public HTTPS metadata document, configured registration or dynamic registration. See [MCP OAuth](oauth.md) for discovery, client authentication, callbacks, scopes and verification.

Deploy the API at `vitalog-api.praveent.com` and the Next.js UI at `vitalog.praveent.com`. Set the API's `PUBLIC_BASE_URL`, `UI_BASE_URL`, `ROOT_EMAIL` and `ROOT_PASSWORD`, and the UI's `API_BASE_URL` and `UI_BASE_URL`. Follow [the Towbar guide](towbar-deployment.md). The consent cookie remains host-only on the API; sibling HTTPS subdomains allow the UI to submit consent with SameSite=Lax. OAuth browser clients can be separately authorized through exact `ALLOWED_ORIGINS`; these origins cannot submit browser consent.

Use the primary `AUTH_KEY` to list or revoke the connection through the API-key management endpoints. Its metadata has a `vlo_…` hint. Revocation blocks subsequent requests; reconnect through OAuth after revocation or expiry. Changing the API origin changes the resource audience, so reconnect clients after a hostname migration.

This ZIP is for personal upload. Packaging and protocol tests do not prove a successful ChatGPT upload or account connection. Check those after merging and deploying. Public-directory publication has separate publisher and review requirements. Package structure follows [OpenAI's plugin documentation](https://developers.openai.com/plugins/build/plugins).
