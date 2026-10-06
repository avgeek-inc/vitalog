import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { accountSettings } from "../db/schema.js";
import { accountSchema, type Account } from "./account-contracts.js";

export class RootAccount {
  constructor(
    private db: Database,
    private email: string,
    private timezone: string,
  ) {}
  private defaults() {
    return {
      id: 1,
      name: this.email.split("@")[0]!,
      dateFormat: "short-month-day-year",
      timeFormat: "12-hour",
      timeZone: this.timezone,
    };
  }
  async get(): Promise<Account> {
    const [stored] = await this.db
      .select()
      .from(accountSettings)
      .where(eq(accountSettings.id, 1));
    const row = stored ?? this.defaults();
    return accountSchema.parse({
      name: row.name,
      email: this.email,
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
