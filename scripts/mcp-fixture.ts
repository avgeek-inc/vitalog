import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { Database } from "../src/db/client.js";
import { OAuthStore, pkceChallenge } from "../src/auth/oauth-store.js";

export const mcpFixtureIssuer = "http://127.0.0.1:3000";

export async function authorizeMcpFixture(
  issuer: string,
  uiOrigin: string,
  credentials: { email: string; password: string },
) {
  const callback = "http://127.0.0.1/callback";
  const registration = await fetch(issuer + "/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Container verification",
      redirect_uris: [callback],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(registration.status, 201);
  const client = await registration.json();
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const resource = issuer + "/mcp";
  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: callback,
    resource,
    scope: "health:read health:write",
    state,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
  });
  const authorization = await fetch(issuer + "/oauth/authorize?" + params, {
    redirect: "manual",
  });
  assert.equal(authorization.status, 302);
  assert.equal(
    authorization.headers.get("location"),
    uiOrigin + "/oauth/authorize",
  );
  const cookie = authorization.headers.get("set-cookie")!.split(";")[0]!;
  const context = await fetch(issuer + "/oauth/request", {
    headers: { Cookie: cookie },
  });
  assert.equal(context.status, 200);
  const request = await context.json();
  const approval = await fetch(issuer + "/oauth/approve", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: uiOrigin,
      Cookie: cookie,
    },
    body: JSON.stringify({
      csrf_token: request.csrf_token,
      action: "allow",
      ...credentials,
    }),
  });
  assert.equal(approval.status, 200);
  const redirect = new URL((await approval.json()).redirect_to);
  assert.equal(redirect.searchParams.get("state"), state);
  assert.equal(redirect.searchParams.get("iss"), issuer);
  const token = await fetch(issuer + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      redirect_uri: callback,
      resource,
      code: redirect.searchParams.get("code")!,
      code_verifier: verifier,
    }),
  });
  assert.equal(token.status, 200);
  return String((await token.json()).access_token);
}

export async function issueMcpFixtureToken(
  db: Database,
  resource: string,
  scopes = ["health:read", "health:write"],
) {
  const store = new OAuthStore(db, resource);
  const verifier = randomBytes(32).toString("base64url");
  const grant = {
    client_id: "verification-client",
    client_name: "Verification client",
    redirect_uri: "http://127.0.0.1/callback",
    resource,
    scopes,
    code_challenge: pkceChallenge(verifier),
  };
  const code = await store.issueCode(undefined, grant);
  const issued = await store.exchange({
    ...grant,
    code,
    code_verifier: verifier,
  });
  assert(issued);
  return issued.access_token;
}
