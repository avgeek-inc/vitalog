import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { oauthClientAssertions } from "../db/schema.js";
import { OAuthError } from "./oauth-error.js";

export const assertionType =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
export const signingAlgorithms = ["RS256", "PS256", "ES256"] as const;
export const publicJwks = z
  .object({
    keys: z
      .array(z.object({ kty: z.enum(["RSA", "EC"]) }).passthrough())
      .min(1)
      .max(10),
  })
  .superRefine((set, context) => {
    if (
      set.keys.some((key) =>
        ["d", "p", "q", "dp", "dq", "qi", "oth", "k"].some(
          (part) => part in key,
        ),
      )
    )
      context.addIssue({
        code: "custom",
        message: "Use only public signing keys",
      });
  });

export async function verifyClientAssertion(
  db: Database,
  clientId: string,
  issuer: string,
  assertion: string,
  jwks: JSONWebKeySet,
  algorithm?: string,
) {
  try {
    const { payload } = await jwtVerify(assertion, createLocalJWKSet(jwks), {
      algorithms: algorithm ? [algorithm] : [...signingAlgorithms],
      issuer: clientId,
      subject: clientId,
      audience: [issuer, issuer + "/oauth/token"],
      requiredClaims: ["iss", "sub", "aud", "exp", "iat", "jti"],
      maxTokenAge: "5 minutes",
    });
    const now = Math.floor(Date.now() / 1000);
    if (
      typeof payload.aud !== "string" ||
      !Number.isInteger(payload.exp) ||
      payload.exp! > now + 300 ||
      !Number.isInteger(payload.iat) ||
      payload.iat! > now ||
      typeof payload.jti !== "string" ||
      !payload.jti.length ||
      payload.jti.length > 256
    )
      throw new Error("Invalid assertion claims");
    const digest = createHash("sha256")
      .update(JSON.stringify([clientId, payload.jti]))
      .digest("hex");
    await db.execute(
      sql`delete from oauth_client_assertions where assertion_digest in (select assertion_digest from oauth_client_assertions where expires_at <= statement_timestamp() limit 1000)`,
    );
    const [stored] = await db
      .insert(oauthClientAssertions)
      .values({
        assertionDigest: digest,
        expiresAt: new Date(payload.exp! * 1000),
      })
      .onConflictDoNothing()
      .returning({ assertionDigest: oauthClientAssertions.assertionDigest });
    if (!stored) throw new Error("Replayed assertion");
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    throw new OAuthError(
      "invalid_client",
      "Client assertion is invalid, expired or already used",
      401,
    );
  }
}
