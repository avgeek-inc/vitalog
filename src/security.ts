import { DomainError } from "./errors.js";

export const MAX_REQUEST_BYTES = 1024 * 1024;
export type CredentialGuard = (value: string) => void;

export function credentialGuard(
  key: string,
  additionalSecrets: string[] = [],
  generatedKeys = true,
): CredentialGuard {
  const secrets = [key, ...additionalSecrets];
  return (value) => {
    if (
      secrets.some((secret) => value.includes(secret)) ||
      (generatedKeys && /v(?:lk|lo|cs)_[A-Za-z0-9_-]{43}/.test(value))
    )
      throw new DomainError(
        "VALIDATION_ERROR",
        "Credentials must only be supplied through the Authorization header",
      );
  };
}

export async function inspectBody(
  message: Request | Response,
  assertCredentialAbsent: CredentialGuard,
  maximumBytes = MAX_REQUEST_BYTES,
  limitMessage = "Request exceeds 1 MiB",
): Promise<void> {
  if (!message.body) return;
  const reader = message.clone().body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        void reader.cancel().catch(() => {});
        throw new DomainError("LIMIT_EXCEEDED", limitMessage);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const text = Buffer.concat(chunks).toString("utf8");
  assertCredentialAbsent(text);
  for (const token of text.matchAll(/"(?:[^"\\]|\\[\s\S])*"/g)) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(token[0]);
    } catch {
      continue;
    }
    if (typeof decoded === "string") assertCredentialAbsent(decoded);
  }
}
