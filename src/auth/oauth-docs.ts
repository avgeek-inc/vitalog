import type { Data } from "../domain/types.js";
import { jsonSchema } from "../registry/primitives.js";
import { authorization, approvalSchema, exchangeSchema } from "./oauth.js";
import { registrationSchema } from "./oauth-clients.js";

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
  registration_endpoint: uri,
  response_types_supported: strings,
  grant_types_supported: strings,
  client_id_metadata_document_supported: { const: true },
  token_endpoint_auth_methods_supported: strings,
  token_endpoint_auth_signing_alg_values_supported: strings,
  code_challenge_methods_supported: strings,
  scopes_supported: strings,
});
const shared = {
  tags: ["OAuth"],
  security: [],
  description:
    "MCP OAuth authorization with CIMD, pre-registered clients and dynamic registration; see docs/oauth.md. Enabled with a canonical public issuer. Public metadata contains no health records or credentials.",
};
const requestModel = {
  ...jsonSchema(authorization),
  additionalProperties: true,
} as Data;
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
      summary: "Open the MCP client's authorization and consent page",
      parameters: Object.entries(properties).map(([name, schema]) => ({
        name,
        in: "query",
        required: (requestModel.required as string[]).includes(name),
        schema,
      })),
      responses: {
        "302": {
          description:
            "Resolve the client through configuration, persistent registration or its HTTPS metadata document. Validate the requested callback before redirecting. A valid request establishes a signed HttpOnly API-host flow cookie and opens the separate Next.js consent screen. Errors return only to a validated callback with issuer and the supplied state. Unknown clients and unregistered callbacks stay local. S256 PKCE is required; unknown OAuth parameters are ignored.",
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
            client_id: { type: "string", maxLength: 512 },
            client_name: { type: "string", minLength: 1, maxLength: 100 },
            redirect_uri: uri,
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
      summary: "Approve or cancel an MCP client's access",
      description:
        "Requires the flow cookie, exact UI_BASE_URL Origin header and matching CSRF token. Allow signs in with ROOT_EMAIL and ROOT_PASSWORD in the JSON body and authorizes the requested scopes. Cancel does not need credentials. Returns the client-bound callback containing iss and the original state when supplied; approval includes a single-use five-minute code. No API key or access token is created until code exchange.",
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
          "Validated MCP client callback URL; no API key is returned",
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
        "Authorization-code exchange with S256 PKCE and exact client, consented callback and canonical MCP resource binding. Public clients use client_id without a secret; configured or dynamically registered confidential clients use their declared client_secret_basic, client_secret_post or private_key_jwt method. JWT clients send a signed assertion with registered public keys and a unique jti; replay is blocked across restarts. HTTP Basic identifies the client when client_id is omitted from the body. Unknown OAuth parameters are ignored. No refresh or client-credentials grants. Atomically consumes the code and creates a scoped 30-day MCP token and its API-key management record. The primary AUTH_KEY can list or revoke this record. Revocation is checked on every MCP request.",
      requestBody: {
        required: true,
        content: {
          "application/x-www-form-urlencoded": {
            schema: {
              ...jsonSchema(exchangeSchema),
              additionalProperties: true,
            },
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
        "401": error,
        "413": { description: "Request exceeds 4 KiB" },
        "422": {
          description:
            "Credentials outside their supported header are rejected",
        },
      },
    },
  },
  "/oauth/register": {
    post: {
      ...shared,
      operationId: "oauth_register_client",
      summary: "Register an OAuth client for MCP compatibility",
      description:
        "RFC 7591 dynamic registration for clients without a metadata document or configured client ID. Accepts HTTPS, literal loopback HTTP and reverse-domain native callbacks. Public clients explicitly use token_endpoint_auth_method=none. The default is client_secret_basic; client_secret_post and private_key_jwt are also supported. JWT clients supply exactly one public jwks or HTTPS jwks_uri and receive no symmetric secret. Only authorization_code/code and health:read/health:write scopes are supported. Unknown metadata fields are ignored and external logos or client URIs are never fetched. Registration grants no ledger access. Limited to ten registrations per source address per minute and 1,000 persisted clients. Store any returned client secret privately; only its SHA-256 digest is retained.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              ...jsonSchema(registrationSchema),
              additionalProperties: true,
            },
          },
        },
      },
      responses: {
        "201": response(
          {
            type: "object",
            required: [
              "client_id",
              "client_id_issued_at",
              "client_name",
              "redirect_uris",
              "token_endpoint_auth_method",
              "grant_types",
              "response_types",
              "scope",
            ],
            properties: {
              ...(jsonSchema(registrationSchema).properties as Data),
              client_id: { type: "string", pattern: "^vcl_[A-Za-z0-9_-]{43}$" },
              client_id_issued_at: { type: "integer" },
              client_secret: {
                type: "string",
                pattern: "^vcs_[A-Za-z0-9_-]{43}$",
                writeOnly: true,
              },
              client_secret_expires_at: { const: 0 },
            },
          },
          "Persisted client registration; optional client secret is returned once",
        ),
        "400": error,
        "413": { description: "Request exceeds 4 KiB" },
        "429": { description: "Registration rate exceeded; Retry-After: 60" },
        "503": error,
      },
    },
  },
};
