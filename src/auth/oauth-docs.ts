import type { Data } from "../domain/types.js";
import { jsonSchema } from "../registry/primitives.js";
import { authorization, approvalSchema, exchangeSchema } from "./oauth.js";

const response = (schema: Data, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const jsonObject = (properties: Data) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const strings = { type: "array", items: { type: "string" } };
const uri = { type: "string", format: "uri" };
const error = response(
  jsonObject({
    error: { type: "string" },
    error_description: { type: "string" },
  }),
  "OAuth protocol error",
);
const resource = jsonObject({
  resource: uri,
  authorization_servers: strings,
  scopes_supported: strings,
  bearer_methods_supported: strings,
  resource_name: { type: "string" },
});
const issuer = jsonObject({
  issuer: uri,
  authorization_response_iss_parameter_supported: { const: true },
  authorization_endpoint: uri,
  token_endpoint: uri,
  response_types_supported: strings,
  grant_types_supported: strings,
  client_id_metadata_document_supported: { const: true },
  token_endpoint_auth_methods_supported: strings,
  code_challenge_methods_supported: strings,
  scopes_supported: strings,
});
const shared = {
  tags: ["OAuth"],
  security: [],
  description:
    "Enabled with a canonical public issuer; see docs/chatgpt-plugin.md. Public metadata contains no health records or credentials.",
};
const requestModel = jsonSchema(authorization) as Data;
const properties = requestModel.properties as Data;

export const oauthPaths: Data = {
  "/.well-known/oauth-protected-resource": {
    get: {
      ...shared,
      operationId: "oauth_resource_metadata",
      summary: "Discover the protected MCP resource",
      responses: {
        "200": response(resource, "RFC 9728 protected resource metadata"),
      },
    },
  },
  "/.well-known/oauth-protected-resource/mcp": {
    get: {
      ...shared,
      operationId: "oauth_mcp_resource_metadata",
      summary: "Discover the path-specific MCP resource",
      responses: {
        "200": response(resource, "RFC 9728 protected resource metadata"),
      },
    },
  },
  "/.well-known/oauth-authorization-server": {
    get: {
      ...shared,
      operationId: "oauth_issuer_metadata",
      summary: "Discover the OAuth issuer",
      responses: {
        "200": response(issuer, "RFC 8414 authorization server metadata"),
      },
    },
  },
  "/oauth/authorize": {
    get: {
      ...shared,
      operationId: "oauth_authorize",
      summary: "Open ChatGPT's authorization and consent page",
      parameters: Object.entries(properties).map(([name, schema]) => ({
        name,
        in: "query",
        required: (requestModel.required as string[]).includes(name),
        schema,
      })),
      responses: {
        "200": {
          description:
            "HeroUI consent form; establishes a signed HttpOnly flow cookie with a five-minute lifetime",
          content: { "text/html": { schema: { type: "string" } } },
        },
        "302": {
          description:
            "Authorization error returned only to the exact ChatGPT callback, with error, state and issuer identification",
          headers: {
            Location: { schema: { type: "string", format: "uri" } },
          },
        },
        "400": error,
      },
    },
  },
  "/oauth/request": {
    get: {
      ...shared,
      operationId: "oauth_connection_request",
      summary: "Read the current browser's consent request",
      security: [{ oauthFlowCookie: [] }],
      responses: {
        "200": response(
          jsonObject({
            client_name: { const: "ChatGPT" },
            scopes: strings,
            csrf_token: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
          }),
          "Private consent request and CSRF token",
        ),
        "400": error,
      },
    },
  },
  "/oauth/approve": {
    post: {
      ...shared,
      operationId: "oauth_approve",
      summary: "Approve or cancel ChatGPT access",
      description:
        "Requires the flow cookie, exact same-origin Origin header and matching CSRF token. Allow signs in with ROOT_EMAIL and ROOT_PASSWORD in the JSON body and authorizes the requested scopes. Cancel does not need credentials. Returns a validated ChatGPT redirect containing state and iss; approval includes a single-use five-minute code. No API key or access token is created until code exchange.",
      security: [{ oauthFlowCookie: [] }],
      parameters: [
        { name: "Origin", in: "header", required: true, schema: uri },
      ],
      requestBody: {
        required: true,
        content: { "application/json": { schema: jsonSchema(approvalSchema) } },
      },
      responses: {
        "200": response(
          jsonObject({ redirect_to: uri }),
          "ChatGPT callback URL; no API key is returned",
        ),
        "400": error,
        "401": response(
          { $ref: "#/components/schemas/Error" },
          "Root email or password is incorrect",
        ),
        "403": { description: "Origin rejected" },
        "413": { description: "Request exceeds 4 KiB" },
        "429": response(
          { $ref: "#/components/schemas/Error" },
          "Approval rate exceeded or sign-in is busy; Retry-After: 60",
        ),
        "503": response(
          { $ref: "#/components/schemas/Error" },
          "Root sign-in is not configured",
        ),
      },
    },
  },
  "/oauth/token": {
    post: {
      ...shared,
      operationId: "oauth_exchange_code",
      summary: "Exchange a PKCE authorization code for an MCP access token",
      description:
        "Public ChatGPT CIMD client; S256 PKCE and exact client, callback and MCP resource binding. Form-encoded authorization_code only. No client-secret or refresh grants. Atomically consumes the code and creates a scoped 30-day MCP token and its API-key management record. The primary AUTH_KEY can list or revoke this record. Existing grants keep their original expiry. Revocation is checked on every MCP request.",
      requestBody: {
        required: true,
        content: {
          "application/x-www-form-urlencoded": {
            schema: jsonSchema(exchangeSchema),
          },
        },
      },
      responses: {
        "200": response(
          jsonObject({
            access_token: {
              type: "string",
              pattern: "^vlo_[A-Za-z0-9_-]{43}$",
              writeOnly: true,
            },
            token_type: { const: "Bearer" },
            expires_in: { type: "integer", minimum: 1, maximum: 2592000 },
            scope: { type: "string" },
          }),
          "Opaque access token; store privately. Cache-Control: no-store",
        ),
        "400": error,
        "413": { description: "Request exceeds 4 KiB" },
        "422": {
          description:
            "Credentials outside their supported header are rejected",
        },
      },
    },
  },
};
