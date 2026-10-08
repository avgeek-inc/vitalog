import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { validTimezone } from "./domain/validation.js";
import { credentialGuard, type CredentialGuard } from "./security.js";
import { rootCredentials, type RootCredentials } from "./auth/root.js";
import {
  attachmentStorageConfiguration,
  type AttachmentStorageConfig,
} from "./attachments/config.js";
import {
  configuredOAuthClients,
  type OAuthClient,
} from "./auth/oauth-clients.js";

export type Config = {
  authDigest: Buffer;
  assertCredentialAbsent: CredentialGuard;
  assertAuthKeyAbsent: CredentialGuard;
  assertEnvironmentCredentialsAbsent: CredentialGuard;
  assertPrimaryCredentialsAbsent: CredentialGuard;
  oauthClients: OAuthClient[];
  rootCredentials?: RootCredentials;
  databaseUrl: string;
  timezone: string;
  port: number;
  allowedHosts: string[];
  publicBaseUrl?: string;
  uiBaseUrl?: string;
  allowedOrigins: string[];
  rateLimit: number;
  attachmentStorage?: AttachmentStorageConfig;
};
export function configuration(env: NodeJS.ProcessEnv = process.env): Config {
  const key = env.AUTH_KEY;
  if (
    !key ||
    key.length < 43 ||
    key.length > 512 ||
    !/^[A-Za-z0-9._~+/=-]+$/.test(key) ||
    /replace|placeholder|changeme|example|operator|secret|password/i.test(key)
  )
    throw new Error(
      "AUTH_KEY must be an operator-supplied secret, 43–512 encoded characters, from at least 32 random bytes",
    );
  const databaseUrl = env.DATABASE_URL;
  const root = rootCredentials(env.ROOT_EMAIL, env.ROOT_PASSWORD);
  if (env.ROOT_PASSWORD === key)
    throw new Error("ROOT_PASSWORD must differ from AUTH_KEY");
  const passwordSecrets = root ? [env.ROOT_PASSWORD!] : [];
  const attachmentStorage = attachmentStorageConfiguration(env);
  const storageSecrets = attachmentStorage
    ? [attachmentStorage.secretAccessKey]
    : [];
  const oauth = configuredOAuthClients(env.OAUTH_CLIENTS);
  if (
    attachmentStorage &&
    [key, env.ROOT_PASSWORD, ...oauth.secrets].includes(
      attachmentStorage.secretAccessKey,
    )
  )
    throw new Error(
      "S3_SECRET_ACCESS_KEY must differ from the primary key, root password and OAuth client secrets",
    );
  if (
    oauth.secrets.some(
      (secret) => secret === key || secret === env.ROOT_PASSWORD,
    )
  )
    throw new Error(
      "OAuth client secrets must differ from the primary key and root password",
    );
  if (!databaseUrl || !/^postgres(?:ql)?:\/\//.test(databaseUrl))
    throw new Error("A PostgreSQL DATABASE_URL is required");
  const timezone = env.DEFAULT_TIMEZONE ?? "Asia/Kolkata";
  validTimezone(timezone);
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be an integer from 1 to 65535");
  const split = (value: string | undefined) =>
    (value ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  const allowedHosts = split(
    env.ALLOWED_HOSTS ?? `localhost:${port},127.0.0.1:${port}`,
  );
  if (
    !allowedHosts.length ||
    allowedHosts.some(
      (host) => host.includes("*") || host.includes("/") || /\s/.test(host),
    )
  )
    throw new Error("ALLOWED_HOSTS requires exact host[:port] values");
  const publicOrigins = [
    ...new Set(
      allowedHosts
        .map((host) => new URL(`https://${host}`))
        .filter(
          ({ hostname }) =>
            hostname.includes(".") &&
            !isIP(hostname) &&
            !hostname.endsWith(".localhost"),
        )
        .map(({ origin }) => origin),
    ),
  ];
  const publicBaseUrl =
    env.PUBLIC_BASE_URL ||
    (publicOrigins.length === 1 ? publicOrigins[0] : undefined);
  if (publicBaseUrl) {
    const origin = new URL(publicBaseUrl);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
      origin.hostname,
    );
    if (
      origin.origin !== publicBaseUrl ||
      !allowedHosts.some(
        (host) => new URL(`${origin.protocol}//${host}`).host === origin.host,
      ) ||
      (origin.protocol !== "https:" &&
        !(origin.protocol === "http:" && loopback))
    )
      throw new Error(
        "PUBLIC_BASE_URL requires an exact HTTPS origin in ALLOWED_HOSTS, or loopback HTTP for development",
      );
  }
  const allowedOrigins = split(env.ALLOWED_ORIGINS);
  const uiBaseUrl = env.UI_BASE_URL || undefined;
  if (uiBaseUrl) {
    const url = new URL(uiBaseUrl);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      url.origin !== uiBaseUrl ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    )
      throw new Error(
        "UI_BASE_URL requires an exact HTTPS origin, or loopback HTTP for development",
      );
  }
  if (
    allowedOrigins.some((origin) => {
      try {
        const url = new URL(origin);
        return (
          url.origin !== origin || !["https:", "http:"].includes(url.protocol)
        );
      } catch {
        return true;
      }
    })
  )
    throw new Error("ALLOWED_ORIGINS requires exact origins");
  const rateLimit = Number(env.RATE_LIMIT_PER_MINUTE ?? 600);
  if (!Number.isInteger(rateLimit) || rateLimit < 1 || rateLimit > 100000)
    throw new Error(
      "RATE_LIMIT_PER_MINUTE must be an integer from 1 to 100000",
    );
  return {
    authDigest: createHash("sha256").update(key).digest(),
    assertCredentialAbsent: credentialGuard(key, [
      ...passwordSecrets,
      ...oauth.secrets,
      ...storageSecrets,
    ]),
    assertAuthKeyAbsent: credentialGuard(key, storageSecrets, false),
    assertEnvironmentCredentialsAbsent: credentialGuard(
      key,
      [...passwordSecrets, ...oauth.secrets, ...storageSecrets],
      false,
    ),
    assertPrimaryCredentialsAbsent: credentialGuard(
      key,
      [...passwordSecrets, ...storageSecrets],
      false,
    ),
    oauthClients: oauth.clients,
    rootCredentials: root,
    databaseUrl,
    timezone,
    port,
    allowedHosts,
    publicBaseUrl,
    uiBaseUrl,
    allowedOrigins,
    rateLimit,
    attachmentStorage,
  };
}
export function authorized(
  header: string | undefined,
  config: Config,
): boolean {
  if (!header || !/^Bearer [A-Za-z0-9._~+/=-]{43,512}$/.test(header))
    return false;
  const actual = createHash("sha256").update(header.slice(7)).digest();
  return timingSafeEqual(actual, config.authDigest);
}
