import { eq, sql } from "drizzle-orm";
import { DomainError } from "../errors.js";
import type { Database } from "../db/client.js";
import { accountSettings } from "../db/schema.js";
import { accountSchema, type Account } from "./account-contracts.js";

export class RootAccount {
  constructor(
    private db: Database,
    private email: string | undefined,
    private timezone: string,
  ) {}
  private identity() {
    if (!this.email)
      throw new DomainError("UNAUTHORIZED", "Account sign-in is unavailable");
    return this.email;
  }
  private defaults() {
    return {
      id: 1,
      name: this.identity().split("@")[0]!,
      dateFormat: "short-month-day-year",
      timeFormat: "12-hour",
      timeZone: this.timezone,
    };
  }
  async get(): Promise<Account> {
    const email = this.identity();
    const [stored] = await this.db
      .select()
      .from(accountSettings)
      .where(eq(accountSettings.id, 1));
    const row = stored ?? this.defaults();
    return accountSchema.parse({
      name: row.name,
      email,
      preferences: {
        dateFormat: row.dateFormat,
        timeFormat: row.timeFormat,
        timeZone: row.timeZone,
      },
    });
  }
  async update(values: { name: string } | Account["preferences"]) {
    await this.db
      .insert(accountSettings)
      .values({ ...this.defaults(), ...values })
      .onConflictDoUpdate({
        target: accountSettings.id,
        set: { ...values, updatedAt: sql`clock_timestamp()` },
      });
    return this.get();
  }
}
