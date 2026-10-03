import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { Config } from "../config.js";
import { authorized } from "../config.js";
import { DomainError } from "../errors.js";
import { inspectBody } from "../security.js";
import { ApiKeys } from "./keys.js";
import { keyPageCsp, pageDocument } from "./page.js";
import { OAuthStore } from "./oauth-store.js";

export const chatGptClientId = "https://chatgpt.com/oauth/client.json";
export const chatGptRedirectUri =
  "https://chatgpt.com/connector_platform_oauth_redirect";
export const oauthScopes = ["health:read", "health:write"] as const;
const encodedSecret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const authorization = z.strictObject({
  response_type: z.literal("code"),
  client_id: z.literal(chatGptClientId),
  redirect_uri: z.literal(chatGptRedirectUri),
  resource: z.string().max(512),
  code_challenge: encodedSecret,
  code_challenge_method: z.literal("S256"),
  state: z.string().min(1).max(512),
  scope: z.string().max(128).optional(),
});
const flowSchema = z.strictObject({
  client_id: z.literal(chatGptClientId),
  redirect_uri: z.literal(chatGptRedirectUri),
  resource: z.string().max(512),
  scopes: z.array(z.enum(oauthScopes)).min(1).max(2),
  code_challenge: encodedSecret,
  state: z.string().min(1).max(512),
  csrf_token: encodedSecret,
  expires_at: z.number().int(),
});
type Flow = z.infer<typeof flowSchema>;
export const exchangeSchema = z.strictObject({
  grant_type: z.literal("authorization_code"),
  code: z.string().regex(/^voc_[A-Za-z0-9_-]{43}$/),
  client_id: z.literal(chatGptClientId),
  redirect_uri: z.literal(chatGptRedirectUri),
  resource: z.string().max(512),
  code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
});
export const approvalSchema = z.strictObject({
  csrf_token: encodedSecret,
  action: z.enum(["allow", "deny"]),
});

class OAuthError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: 400 | 401 | 503 = 400,
  ) {
    super(message);
  }
}
function parameters(search: URLSearchParams) {
  const output: Record<string, string> = Object.create(null);
  for (const [name, value] of search) {
    if (Object.hasOwn(output, name))
      throw new OAuthError("invalid_request", "Use each parameter once");
    output[name] = value;
  }
  return output;
}
function requestedScopes(scope: string | undefined) {
  const parsed = z
    .array(z.enum(oauthScopes))
    .min(1)
    .max(2)
    .safeParse(scope === undefined ? [...oauthScopes] : scope.split(" "));
  if (!parsed.success || new Set(parsed.data).size !== parsed.data.length)
    throw new OAuthError(
      "invalid_scope",
      "Use health:read and/or health:write",
    );
  return parsed.data;
}
export function oauthChallenge(
  issuer: string,
  error?: "invalid_token" | "insufficient_scope",
) {
  return `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp", scope="${oauthScopes.join(" ")}"${error ? `, error="${error}", error_description="Connect Vitalog to access your health ledger"` : ""}`;
}

export function oauthRoutes(keys: ApiKeys, store: OAuthStore, config: Config) {
  const issuer = config.publicBaseUrl!;
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
    return value + "." + sign(value);
  };
  const readFlow = (c: Context): Flow => {
    const cookie = getCookie(c, cookieName);
    if (!cookie || cookie.length > 4096)
      throw new OAuthError(
        "invalid_request",
        "Restart the connection from ChatGPT",
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
        "Restart the connection from ChatGPT",
      );
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    } catch {
      throw new OAuthError(
        "invalid_request",
        "Restart the connection from ChatGPT",
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
        "The connection request expired. Restart from ChatGPT",
      );
    return flow.data;
  };
  let clientValidatedUntil = 0;
  let validatingClient: Promise<void> | undefined;
  const validateClient = async () => {
    if (clientValidatedUntil > Date.now()) return;
    if (!validatingClient)
      validatingClient = (async () => {
        const response = await fetch(chatGptClientId, {
          redirect: "error",
          signal: AbortSignal.timeout(5000),
          headers: { Accept: "application/json" },
        });
        if (
          !response.ok ||
          !/^application\/json(?:\s*;|$)/i.test(
            response.headers.get("content-type") ?? "",
          )
        )
          throw new OAuthError(
            "temporarily_unavailable",
            "ChatGPT client metadata is unavailable",
            503,
          );
        await inspectBody(response, config.assertCredentialAbsent, 8192);
        const metadata = z
          .object({
            client_id: z.literal(chatGptClientId),
            redirect_uris: z.array(z.string()).max(10),
            token_endpoint_auth_method: z.string().optional(),
            token_endpoint_auth_methods_supported: z
              .array(z.string())
              .optional(),
          })
          .parse(await response.json());
        if (
          !metadata.redirect_uris.includes(chatGptRedirectUri) ||
          !(
            metadata.token_endpoint_auth_method === "none" ||
            metadata.token_endpoint_auth_methods_supported?.includes("none")
          )
        )
          throw new OAuthError(
            "temporarily_unavailable",
            "ChatGPT client metadata is incompatible",
            503,
          );
        clientValidatedUntil = Date.now() + 600_000;
      })();
    try {
      await validatingClient;
    } catch {
      throw new OAuthError(
        "temporarily_unavailable",
        "ChatGPT client metadata is unavailable",
        503,
      );
    } finally {
      validatingClient = undefined;
    }
  };
  const routes = new Hono();
  routes.onError((error, c) => {
    if (error instanceof OAuthError)
      return c.json(
        { error: error.code, error_description: error.message },
        error.status,
      );
    if (error instanceof DomainError)
      return c.json(error.toJSON(), error.status);
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
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      client_id_metadata_document_supported: true,
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [...oauthScopes],
    }),
  );
  routes.get(
    "/oauth/authorize",
    async (c, next) => {
      const query = new URL(c.req.url).searchParams;
      c.header("Referrer-Policy", "no-referrer");
      let input: z.infer<typeof authorization>;
      let scopes: Flow["scopes"];
      try {
        const params = parameters(query);
        const parsed = authorization.safeParse(params);
        if (!parsed.success)
          throw new OAuthError(
            "invalid_request",
            "Use the ChatGPT client, callback and S256 PKCE",
          );
        input = parsed.data;
        if (input.resource !== resource)
          throw new OAuthError("invalid_target", "Use this MCP resource");
        scopes = requestedScopes(input.scope);
        await validateClient();
      } catch (error) {
        if (
          !(error instanceof OAuthError) ||
          query.getAll("client_id").length !== 1 ||
          query.get("client_id") !== chatGptClientId ||
          query.getAll("redirect_uri").length !== 1 ||
          query.get("redirect_uri") !== chatGptRedirectUri
        )
          throw error;
        const redirect = new URL(chatGptRedirectUri);
        redirect.searchParams.set("error", error.code);
        redirect.searchParams.set("error_description", error.message);
        redirect.searchParams.set("iss", issuer);
        const state = authorization.shape.state.safeParse(query.get("state"));
        if (query.getAll("state").length === 1 && state.success)
          redirect.searchParams.set("state", state.data);
        deleteCookie(c, cookieName, cookieOptions);
        return c.redirect(redirect.toString(), 302);
      }
      const flow: Flow = {
        client_id: input.client_id,
        redirect_uri: input.redirect_uri,
        resource,
        scopes,
        code_challenge: input.code_challenge,
        state: input.state,
        csrf_token: randomBytes(32).toString("base64url"),
        expires_at: Date.now() + 300_000,
      };
      setCookie(c, cookieName, encode(flow), { ...cookieOptions, maxAge: 300 });
      c.header("Content-Security-Policy", keyPageCsp);
      await next();
    },
    pageDocument,
  );
  routes.get("/oauth/request", (c) => {
    const flow = readFlow(c);
    return c.json({
      client_name: "ChatGPT",
      scopes: flow.scopes,
      csrf_token: flow.csrf_token,
    });
  });
  routes.post("/oauth/approve", async (c) => {
    if (
      c.req.header("origin") !== issuer ||
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
        "Restart the connection from ChatGPT",
      );
    const redirect = new URL(flow.redirect_uri);
    redirect.searchParams.set("state", flow.state);
    redirect.searchParams.set("iss", issuer);
    if (approval.data.action === "deny")
      redirect.searchParams.set("error", "access_denied");
    else {
      const header = c.req.header("authorization");
      const key = authorized(header, config)
        ? undefined
        : await keys.findActive(header);
      if (!key)
        throw new OAuthError(
          "access_denied",
          "Use an active generated API key",
          401,
        );
      redirect.searchParams.set("code", await store.issueCode(key.id, flow));
    }
    deleteCookie(c, cookieName, cookieOptions);
    return c.json({ redirect_to: redirect.toString() });
  });
  routes.post("/oauth/token", async (c) => {
    if (
      [...new URL(c.req.url).searchParams].length ||
      c.req.header("authorization") ||
      !/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(
        c.req.header("content-type") ?? "",
      )
    )
      throw new OAuthError(
        "invalid_request",
        "Use a public-client form-encoded token request",
      );
    const input = exchangeSchema.safeParse(
      parameters(new URLSearchParams(await c.req.text())),
    );
    if (!input.success)
      throw new OAuthError(
        "invalid_request",
        "Supply the authorization code, client, callback, resource and verifier",
      );
    const token = await store.exchange(input.data);
    if (!token)
      throw new OAuthError(
        "invalid_grant",
        "The authorization code is invalid, expired or already used",
      );
    return c.json(token);
  });
  return routes;
}
