export type AttachmentStorageConfig = {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  prefix: string;
};

export function attachmentStorageConfiguration(
  env: NodeJS.ProcessEnv,
): AttachmentStorageConfig | undefined {
  const bucket = env.S3_BUCKET;
  if (!bucket) {
    if (
      ["S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"].some(
        (key) => env[key],
      )
    )
      throw new Error(
        "S3_BUCKET is required when attachment storage is configured",
      );
    return undefined;
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))
    throw new Error("S3_BUCKET must be a valid bucket name");
  const accessKeyId = env.S3_ACCESS_KEY_ID;
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey || secretAccessKey.length < 8)
    throw new Error(
      "S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required for attachment storage",
    );
  const endpoint = env.S3_ENDPOINT || undefined;
  if (endpoint) {
    const url = new URL(endpoint);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        ))
    )
      throw new Error(
        "S3_ENDPOINT requires an HTTPS origin, or loopback HTTP for development",
      );
  }
  const region = env.S3_REGION || "us-east-1";
  if (!/^[a-z0-9-]{1,80}$/.test(region))
    throw new Error("S3_REGION is invalid");
  if (
    env.S3_FORCE_PATH_STYLE &&
    !["true", "false"].includes(env.S3_FORCE_PATH_STYLE)
  )
    throw new Error("S3_FORCE_PATH_STYLE must be true or false");
  const prefix = env.S3_PREFIX || "vitalog";
  if (
    !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(prefix) ||
    prefix.length > 200
  )
    throw new Error(
      "S3_PREFIX requires nonempty safe path segments without a trailing slash",
    );
  return {
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: env.S3_FORCE_PATH_STYLE
      ? env.S3_FORCE_PATH_STYLE === "true"
      : !!endpoint,
    prefix,
  };
}
