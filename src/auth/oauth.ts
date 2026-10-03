import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { Config } from "../config.js";
import { DomainError } from "../errors.js";
import { keyCreation } from "./contracts.js";
import { RootAuthentication } from "./root.js";
import { OAuthStore } from "./oauth-store.js";
import { OAuthError } from "./oauth-error.js";
import { assertionType, signingAlgorithms } from "./oauth-assertions.js";
import {
  OAuthClients,
  clientId,
  redirectUri,
  oauthScopes,
  parseScopes,
  redirectMatches,
  registrationSchema,
  type OAuthClient,
} from "./oauth-clients.js";

const encodedSecret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const authorization = z.object({
  response_type: z.literal("code"),
  client_id: clientId,
  redirect_uri: redirectUri,
  resource: z.string().max(512),
  code_challenge: encodedSecret,
  code_challenge_method: z.literal("S256"),
  state: z.string().max(512).optional(),
  scope: z.string().max(128).optional(),
});
const flowSchema = z.strictObject({
  client_id: clientId,
  client_name: z.string().min(1).max(100),
  redirect_uri: redirectUri,
  resource: z.string().max(512),
  scopes: z.array(z.enum(oauthScopes)).min(1).max(2),
  code_challenge: encodedSecret,
  state: z.string().max(512).optional(),
  csrf_token: encodedSecret,
  expires_at: z.number().int(),
});
type Flow = z.infer<typeof flowSchema>;
export const exchangeSchema = z.object({
  grant_type: z.literal("authorization_code"),
  code: z.string().regex(/^voc_[A-Za-z0-9_-]{43}$/),
  client_id: clientId.optional(),
  client_secret: z.string().min(1).max(512).optional(),
  client_assertion: z.string().min(1).max(3072).optional(),
  client_assertion_type: z.literal(assertionType).optional(),
  redirect_uri: redirectUri,
  resource: z.string().max(512),
  code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
});
export const approvalSchema = z.discriminatedUnion("action", [
  z.strictObject({
    csrf_token: encodedSecret,
    action: z.literal("allow"),
    ...keyCreation.shape,
  }),
  z.strictObject({ csrf_token: encodedSecret, action: z.literal("deny") }),
]);

function parameters(search: URLSearchParams) {
  const output: Record<string, string> = Object.create(null);
  for (const [name, value] of search) {
    if (Object.hasOwn(output, name))
      throw new OAuthError("invalid_request", "Use each parameter once");
    output[name] = value;
  }
  return output;
}
function canonicalResource(value: string) {
  try {
    const uri = new URL(value);
    return uri.username || uri.password || uri.hash || value.includes("#")
      ? undefined
      : uri.href;
  } catch {
    return undefined;
  }
}
export function oauthChallenge(
  issuer: string,
  error?: "invalid_token" | "insufficient_scope",
  scopes: string[] = [...oauthScopes],
) {
  return `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp", scope="${scopes.join(" ")}"${error ? `, error="${error}", error_description="Connect Vitalog to access your health ledger"` : ""}`;
}

export function oauthRoutes(
  root: RootAuthentication,
  store: OAuthStore,
  config: Config,
  clients: OAuthClients,
) {
  const issuer = config.publicBaseUrl!;
  const uiOrigin = config.uiBaseUrl;
  const resource = issuer + "/mcp";
  const secure = issuer.startsWith("https:");
  const cookieName = secure ? "__Secure-vitalog-oauth" : "vitalog-oauth";
  const cookieOptions = {
    path: "/oauth",
    secure,
    httpOnly: true,
    sameSite: "Lax" as const,
  };
  const sign = (value: string) =>
    createHmac("sha256", config.authDigest)
      .update("vitalog-oauth:" + value)
      .digest("base64url");
  const encode = (flow: Flow) => {
    const value = Buffer.from(JSON.stringify(flow)).toString("base64url");
    const cookie = value + "." + sign(value);
    if (cookie.length > 4000)
      throw new OAuthError(
        "invalid_request",
        "Connection request is too large",
      );
    return cookie;
  };
  const readFlow = (c: Context): Flow => {
    const cookie = getCookie(c, cookieName);
    if (!cookie || cookie.length > 4096)
      throw new OAuthError(
        "invalid_request",
        "Restart the connection from your MCP client",
      );
    const [value, signature, extra] = cookie.split(".");
    if (
      !value ||
      !signature ||
      extra ||
      !/^[A-Za-z0-9_-]{43}$/.test(signature) ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(sign(value)))
    )
      throw new OAuthError(
        "invalid_request",
        "Restart the connection from your MCP client",
      );
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    } catch {
      throw new OAuthError(
        "invalid_request",
        "Restart the connection from your MCP client",
      );
    }
    const flow = flowSchema.safeParse(decoded);
    if (
      !flow.success ||
      flow.data.resource !== resource ||
      flow.data.expires_at <= Date.now() ||
      flow.data.expires_at > Date.now() + 300_000
    )
      throw new OAuthError(
        "invalid_request",
        "The connection request expired. Restart from your MCP client",
      );
    return flow.data;
  };
  const routes = new Hono();
  routes.onError((error, c) => {
    if (error instanceof OAuthError) {
      if (error.status === 401)
        c.header("WWW-Authenticate", 'Basic realm="Vitalog"');
      return c.json(
        { error: error.code, error_description: error.message },
        error.status,
      );
    }
    if (error instanceof DomainError) {
      if (error.code === "RATE_LIMITED") c.header("Retry-After", "60");
      return c.json(error.toJSON(), error.status);
    }
    return c.json(
      {
        error: "server_error",
        error_description: "The connection could not be completed",
      },
      500,
    );
  });
  const protectedResource = {
    resource,
    authorization_servers: [issuer],
    scopes_supported: [...oauthScopes],
    bearer_methods_supported: ["header"],
    resource_name: "Vitalog",
  };
  routes.get("/.well-known/oauth-protected-resource", (c) =>
    c.json(protectedResource),
  );
  routes.get("/.well-known/oauth-protected-resource/mcp", (c) =>
    c.json(protectedResource),
  );
  routes.get("/.well-known/oauth-authorization-server", (c) =>
    c.json({
      issuer,
      authorization_response_iss_parameter_supported: true,
      authorization_endpoint: issuer + "/oauth/authorize",
      token_endpoint: issuer + "/oauth/token",
      registration_endpoint: issuer + "/oauth/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      client_id_metadata_document_supported: true,
      token_endpoint_auth_methods_supported: [
        "none",
        "client_secret_basic",
        "client_secret_post",
        "private_key_jwt",
      ],
      token_endpoint_auth_signing_alg_values_supported: [...signingAlgorithms],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [...oauthScopes],
    }),
  );
  routes.post("/oauth/register", async (c) => {
    if (
      [...new URL(c.req.url).searchParams].length ||
      !/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? "")
    )
      throw new OAuthError(
        "invalid_client_metadata",
        "Use a JSON client registration request",
      );
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new OAuthError(
        "invalid_client_metadata",
        "Use a JSON client registration request",
      );
    }
    const parsed = registrationSchema.safeParse(body);
    if (!parsed.success)
      throw new OAuthError(
        parsed.error.issues.some((issue) =>
          issue.path.includes("redirect_uris"),
        )
          ? "invalid_redirect_uri"
          : "invalid_client_metadata",
        "Supply valid callbacks and supported client metadata",
      );
    return c.json(await clients.register(parsed.data), 201);
  });
  routes.get("/oauth/authorize", async (c) => {
    if (!uiOrigin)
      throw new OAuthError(
        "temporarily_unavailable",
        "The connection page is not configured",
        503,
      );
    const query = new URL(c.req.url).searchParams;
    c.header("Referrer-Policy", "no-referrer");
    let input: z.infer<typeof authorization>;
    let scopes: string[];
    let client: OAuthClient | undefined;
    let callback: string | undefined;
    try {
      if (
        query.getAll("client_id").length !== 1 ||
        query.getAll("redirect_uri").length !== 1
      )
        throw new OAuthError(
          "invalid_request",
          "Supply a single client ID and callback",
        );
      const id = clientId.safeParse(query.get("client_id"));
      const redirect = redirectUri.safeParse(query.get("redirect_uri"));
      if (!id.success || !redirect.success)
        throw new OAuthError(
          "invalid_request",
          "Supply a valid client ID and callback",
        );
      client = await clients.resolve(id.data);
      if (
        !client.redirect_uris.some((uri) => redirectMatches(uri, redirect.data))
      )
        throw new OAuthError(
          "invalid_request",
          "The callback is not registered for this client",
        );
      callback = redirect.data;
      const params = parameters(query);
      if (params.response_type !== undefined && params.response_type !== "code")
        throw new OAuthError(
          "unsupported_response_type",
          "Use the authorization-code response type",
        );
      const parsed = authorization.safeParse(params);
      if (!parsed.success)
        throw new OAuthError(
          "invalid_request",
          "Supply an authorization-code request with S256 PKCE",
        );
      input = parsed.data;
      if (canonicalResource(input.resource) !== resource)
        throw new OAuthError("invalid_target", "Use this MCP resource");
      scopes = parseScopes(input.scope ?? client.scope);
      if (scopes.some((scope) => !parseScopes(client!.scope).includes(scope)))
        throw new OAuthError(
          "invalid_scope",
          "The client is not registered for these scopes",
        );
    } catch (error) {
      deleteCookie(c, cookieName, cookieOptions);
      if (!(error instanceof OAuthError) || !client || !callback) throw error;
      const redirect = new URL(callback);
      redirect.searchParams.set("error", error.code);
      redirect.searchParams.set("error_description", error.message);
      redirect.searchParams.set("iss", issuer);
      const state = authorization.shape.state.safeParse(query.get("state"));
      if (
        query.getAll("state").length === 1 &&
        state.success &&
        state.data !== undefined
      )
        redirect.searchParams.set("state", state.data);
      return c.redirect(redirect.toString(), 302);
    }
    const flow: Flow = {
      client_id: input.client_id,
      client_name: client.client_name,
      redirect_uri: input.redirect_uri,
      resource,
      scopes: scopes as Flow["scopes"],
      code_challenge: input.code_challenge,
      state: input.state,
      csrf_token: randomBytes(32).toString("base64url"),
      expires_at: Date.now() + 300_000,
    };
    setCookie(c, cookieName, encode(flow), { ...cookieOptions, maxAge: 300 });
    return c.redirect(uiOrigin + "/oauth/authorize", 302);
  });
  routes.get("/oauth/request", (c) => {
    const flow = readFlow(c);
    return c.json({
      client_id: flow.client_id,
      client_name: flow.client_name,
      redirect_uri: flow.redirect_uri,
      scopes: flow.scopes,
      csrf_token: flow.csrf_token,
    });
  });
  routes.post("/oauth/approve", async (c) => {
    if (
      !uiOrigin ||
      c.req.header("origin") !== uiOrigin ||
      [...new URL(c.req.url).searchParams].length ||
      !/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? "")
    )
      throw new OAuthError(
        "invalid_request",
        "Use the Vitalog connection page",
      );
    const flow = readFlow(c);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new OAuthError("invalid_request", "Use a JSON approval request");
    }
    const approval = approvalSchema.safeParse(body);
    if (
      !approval.success ||
      !timingSafeEqual(
        Buffer.from(approval.data.csrf_token),
        Buffer.from(flow.csrf_token),
      )
    )
      throw new OAuthError(
        "invalid_request",
        "Restart the connection from your MCP client",
      );
    const redirect = new URL(flow.redirect_uri);
    if (flow.state !== undefined)
      redirect.searchParams.set("state", flow.state);
    redirect.searchParams.set("iss", issuer);
    if (approval.data.action === "deny")
      redirect.searchParams.set("error", "access_denied");
    else {
      config.assertCredentialAbsent(approval.data.email);
      await root.verify(approval.data.email, approval.data.password);
      redirect.searchParams.set("code", await store.issueCode(undefined, flow));
    }
    deleteCookie(c, cookieName, cookieOptions);
    return c.json({ redirect_to: redirect.toString() });
  });
  routes.post("/oauth/token", async (c) => {
    if (
      [...new URL(c.req.url).searchParams].length ||
      !/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(
        c.req.header("content-type") ?? "",
      )
    )
      throw new OAuthError(
        "invalid_request",
        "Use a form-encoded token request",
      );
    const params = parameters(new URLSearchParams(await c.req.text()));
    const header = c.req.header("authorization");
    let basic: { id: string; secret: string } | undefined;
    if (header) {
      if (!/^Basic [A-Za-z0-9+/]+={0,2}$/.test(header))
        throw new OAuthError(
          "invalid_request",
          "Use HTTP Basic client authentication",
        );
      try {
        const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
        const separator = decoded.indexOf(":");
        if (separator < 1) throw new Error("Invalid Basic credentials");
        basic = {
          id: decodeURIComponent(
            decoded.slice(0, separator).replaceAll("+", " "),
          ),
          secret: decodeURIComponent(
            decoded.slice(separator + 1).replaceAll("+", " "),
          ),
        };
      } catch {
        throw new OAuthError(
          "invalid_client",
          "Client authentication failed",
          401,
        );
      }
      if (
        params.client_secret !== undefined ||
        params.client_assertion !== undefined ||
        params.client_assertion_type !== undefined ||
        (params.client_id !== undefined && params.client_id !== basic.id)
      )
        throw new OAuthError(
          "invalid_request",
          "Use a single client authentication method",
        );
      params.client_id = basic.id;
    }
    if (params.grant_type !== "authorization_code")
      throw new OAuthError(
        "unsupported_grant_type",
        "Use the authorization-code grant",
      );
    const input = exchangeSchema.safeParse(params);
    if (!input.success)
      throw new OAuthError(
        "invalid_request",
        "Supply the authorization code, client, callback, resource and verifier",
      );
    if (!input.data.client_id)
      throw new OAuthError("invalid_client", "Supply the client ID");
    if (
      !!input.data.client_assertion !== !!input.data.client_assertion_type ||
      (input.data.client_assertion && input.data.client_secret)
    )
      throw new OAuthError(
        "invalid_request",
        "Use a single complete client authentication method",
      );
    await clients.authenticate(
      input.data.client_id,
      basic?.secret ?? input.data.client_secret,
      basic
        ? "client_secret_basic"
        : input.data.client_secret
          ? "client_secret_post"
          : "none",
      input.data.client_assertion
        ? { jwt: input.data.client_assertion, issuer }
        : undefined,
    );
    const token = await store.exchange({
      ...input.data,
      client_id: input.data.client_id,
      resource: canonicalResource(input.data.resource) ?? "",
    });
    if (!token)
      throw new OAuthError(
        "invalid_grant",
        "The authorization code is invalid, expired or already used",
      );
    return c.json(token);
  });
  return routes;
}
