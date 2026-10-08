export function publicOrigin(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required`);
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.origin !== value ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  )
    throw new Error(
      `${name} must be an exact HTTPS origin, or loopback HTTP for development`,
    );
  return url.origin;
}

export function webConfiguration(env: NodeJS.ProcessEnv = process.env) {
  return {
    apiBaseUrl: publicOrigin(env.API_BASE_URL, "API_BASE_URL"),
    uiBaseUrl: publicOrigin(env.UI_BASE_URL, "UI_BASE_URL"),
  };
}

export function documentationUrl(env: NodeJS.ProcessEnv = process.env) {
  return env.DOCS_BASE_URL
    ? publicOrigin(env.DOCS_BASE_URL, "DOCS_BASE_URL")
    : "https://www.vitalog.dev";
}

export function mcpDocumentationUrl(env: NodeJS.ProcessEnv = process.env) {
  return env.DOCS_BASE_URL
    ? publicOrigin(env.DOCS_BASE_URL, "DOCS_BASE_URL") + "/mcp-guide"
    : "https://www.vitalog.dev/mcp-guide";
}

export function serverApiBaseUrl(env: NodeJS.ProcessEnv = process.env) {
  if (!env.API_INTERNAL_BASE_URL)
    return publicOrigin(env.API_BASE_URL, "API_BASE_URL");
  const url = new URL(env.API_INTERNAL_BASE_URL);
  if (
    url.origin !== env.API_INTERNAL_BASE_URL ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw new Error(
      "API_INTERNAL_BASE_URL must be an exact HTTP or HTTPS origin",
    );
  return url.origin;
}
