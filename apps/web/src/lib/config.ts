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
