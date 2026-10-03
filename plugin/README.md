# Vitalog plugin

This package connects ChatGPT to `https://vitalog.praveent.com/mcp` and includes the Vitalog logo and a workflow for using the health ledger. It contains no credentials.

Deploy the follow-up server changes before connecting. At `https://vitalog.praveent.com/api-keys`, generate an API key with your configured email and password and copy it.

Upload `vitalog-plugin.zip` through ChatGPT's **New Plugin** upload dialog. When connecting the declared MCP server, choose OAuth. On Vitalog's **Connect ChatGPT** page, enter the generated API key and approve the displayed permissions. Vitalog automatically gives ChatGPT a separate connection token with the key's remaining lifetime. You do not need to create or copy that token, and your root password stays with Vitalog. Reconnect with a new key after expiry.

This connection step is needed because [ChatGPT's authenticated MCP connections use OAuth and cannot send custom API keys directly](https://developers.openai.com/plugins/build/auth). Vitalog handles the handshake using your generated key.

Use the primary `AUTH_KEY` with Vitalog's API-key management endpoints to list or revoke keys. Revoking the linked key, or revoking all keys, also blocks the ChatGPT connection on its next request.

The archive is intended for personal upload. Publishing it in the public directory is a separate process with domain verification, publisher information and review requirements.
