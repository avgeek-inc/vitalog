# Vitalog plugin

This package connects ChatGPT to `https://vitalog-api.praveent.com/mcp` and includes the Vitalog logo and a workflow for using the health ledger. It contains no credentials.

Deploy the follow-up server changes before connecting and configure `ROOT_EMAIL` and `ROOT_PASSWORD` for sign-in.

Upload `vitalog-plugin.zip` through ChatGPT's **New Plugin** upload dialog. When connecting the declared MCP server, choose OAuth. On Vitalog's **Connect ChatGPT** page, sign in with your root email and password and approve the displayed permissions. Vitalog returns an authorization code to ChatGPT, which exchanges it for a 30-day MCP access token automatically. Your password stays with Vitalog. Reconnect by signing in again after expiry.

Vitalog handles [ChatGPT's authorization-code OAuth flow with PKCE](https://developers.openai.com/plugins/build/auth). You do not need to generate, paste or copy an API key. The callback contains only the code; the access token is delivered privately during exchange.

Use the primary `AUTH_KEY` with Vitalog's API-key management endpoints to list or revoke the ChatGPT connection's record, identified by its `vlo_…` token hint. Revoking that record, or revoking all keys, blocks access on the next request. Revoke-all also cancels pending authorization codes.

The archive is intended for personal upload. Publishing it in the public directory is a separate process with domain verification, publisher information and review requirements.
