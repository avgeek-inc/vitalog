import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { validTimezone } from "./domain/validation.js";
import { credentialGuard, type CredentialGuard } from "./security.js";
import { rootCredentials, type RootCredentials } from "./auth/root.js";

export type Config = {
  authDigest: Buffer;
  assertCredentialAbsent: CredentialGuard;
  assertAuthKeyAbsent: CredentialGuard;
  assertEnvironmentCredentialsAbsent: CredentialGuard;
  rootCredentials?: RootCredentials;
  databaseUrl: string;
  timezone: string;
  port: number;
  allowedHosts: string[];
  publicBaseUrl?: string;
  allowedOrigins: string[];
  trustedProxyIps: string[];
  rateLimit: number;
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
  if (env.TRUST_PROXY && !["true", "false"].includes(env.TRUST_PROXY))
    throw new Error("TRUST_PROXY must be true or false");
  const trustedProxyIps =
    env.TRUST_PROXY === "true" ? split(env.TRUSTED_PROXY_IPS) : [];
  if (
    env.TRUST_PROXY === "true" &&
    (!trustedProxyIps.length || trustedProxyIps.some((ip) => !isIP(ip)))
  )
    throw new Error("TRUSTED_PROXY_IPS is required when TRUST_PROXY=true");
  const rateLimit = Number(env.RATE_LIMIT_PER_MINUTE ?? 600);
  if (!Number.isInteger(rateLimit) || rateLimit < 1 || rateLimit > 100000)
    throw new Error(
      "RATE_LIMIT_PER_MINUTE must be an integer from 1 to 100000",
    );
  return {
    authDigest: createHash("sha256").update(key).digest(),
    assertCredentialAbsent: credentialGuard(key, passwordSecrets),
    assertAuthKeyAbsent: credentialGuard(key, [], false),
    assertEnvironmentCredentialsAbsent: credentialGuard(
      key,
      passwordSecrets,
      false,
    ),
    rootCredentials: root,
    databaseUrl,
    timezone,
    port,
    allowedHosts,
    publicBaseUrl,
    allowedOrigins,
    trustedProxyIps,
    rateLimit,
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
