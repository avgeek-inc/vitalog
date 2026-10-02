import { createHmac, timingSafeEqual } from "node:crypto";
import { DomainError } from "../errors.js";
import { CATALOG_VERSION } from "../registry/definitions.js";
import { canonical, hash } from "./canonical.js";
import { object, type Data } from "./types.js";

export class Cursors {
  constructor(private signingKey: string) {}
  encode(filters: unknown, position: Data): string {
    const body = Buffer.from(
      canonical({ version: CATALOG_VERSION, filters: hash(filters), position }),
    ).toString("base64url");
    return `${body}.${createHmac("sha256", this.signingKey).update(body).digest("base64url")}`;
  }
  decode(cursor: string, filters: unknown): Data {
    const [body, signature, extra] = cursor.split(".");
    if (!body || !signature || extra)
      throw new DomainError("VALIDATION_ERROR", "Invalid continuation cursor");
    const expected = createHmac("sha256", this.signingKey)
      .update(body)
      .digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(expected, actual))
      throw new DomainError("VALIDATION_ERROR", "Invalid continuation cursor");
    let data: Data;
    try {
      data = object(JSON.parse(Buffer.from(body, "base64url").toString()));
    } catch {
      throw new DomainError("VALIDATION_ERROR", "Invalid continuation cursor");
    }
    if (data.version !== CATALOG_VERSION)
      throw new DomainError(
        "CATALOG_VERSION_MISMATCH",
        "Restart discovery using the current catalog version",
        [],
        { current_catalog_version: CATALOG_VERSION },
      );
    if (data.filters !== hash(filters))
      throw new DomainError(
        "VALIDATION_ERROR",
        "Cursor filters or page size changed",
      );
    return object(data.position);
  }
}
