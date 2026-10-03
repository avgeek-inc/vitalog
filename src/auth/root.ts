import {
  createHash,
  randomBytes,
  scrypt,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { DomainError } from "../errors.js";
import { keyCreation } from "./contracts.js";

const scryptOptions = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
export type RootCredentials = {
  emailDigest: Buffer;
  salt: Buffer;
  passwordDigest: Buffer;
};

export function rootCredentials(
  email: string | undefined,
  password: string | undefined,
): RootCredentials | undefined {
  if (!email && !password) return undefined;
  const parsedEmail = keyCreation.shape.email.safeParse(email);
  if (
    !parsedEmail.success ||
    !password ||
    password.trim().length < 15 ||
    Buffer.byteLength(password) > 256
  )
    throw new Error(
      "Set ROOT_EMAIL and ROOT_PASSWORD together; use a valid email and a password of at least 15 characters and at most 256 UTF-8 bytes",
    );
  const salt = randomBytes(16);
  return {
    emailDigest: createHash("sha256")
      .update(parsedEmail.data.toLowerCase())
      .digest(),
    salt,
    passwordDigest: scryptSync(password, salt, 32, scryptOptions),
  };
}

export class RootAuthentication {
  private attempts = new Map<string, { count: number; reset: number }>();
  private verifying = 0;
  constructor(private credentials: RootCredentials | undefined) {}

  limit(address: string): void {
    const now = Date.now();
    for (const [key, bucket] of this.attempts)
      if (bucket.reset <= now) this.attempts.delete(key);
    for (const [key, maximum] of [
      ["global", 30],
      ["peer:" + address, 5],
    ] as const) {
      const bucket = this.attempts.get(key) ?? {
        count: 0,
        reset: now + 60_000,
      };
      bucket.count++;
      this.attempts.set(key, bucket);
      if (bucket.count > maximum)
        throw new DomainError(
          "RATE_LIMITED",
          "Too many key generation attempts; try again in a minute",
        );
    }
  }

  async verify(email: string, password: string): Promise<void> {
    if (!this.credentials)
      throw new DomainError(
        "UNAVAILABLE",
        "API key generation is not configured",
      );
    if (this.verifying >= 2)
      throw new DomainError(
        "RATE_LIMITED",
        "Key generation is busy; try again in a minute",
      );
    this.verifying++;
    try {
      const actual = await new Promise<Buffer>((resolve, reject) => {
        scrypt(
          password,
          this.credentials!.salt,
          32,
          scryptOptions,
          (error, digest) => {
            if (error) reject(error);
            else resolve(digest);
          },
        );
      });
      const emailDigest = createHash("sha256")
        .update(email.trim().toLowerCase())
        .digest();
      const emailMatches = timingSafeEqual(
        emailDigest,
        this.credentials.emailDigest,
      );
      const passwordMatches = timingSafeEqual(
        actual,
        this.credentials.passwordDigest,
      );
      if (!emailMatches || !passwordMatches)
        throw new DomainError("UNAUTHORIZED", "Email or password is incorrect");
    } finally {
      this.verifying--;
    }
  }
}
