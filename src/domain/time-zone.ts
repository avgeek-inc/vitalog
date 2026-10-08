import { sql, type SQL } from "drizzle-orm";
import { healthRecords } from "../db/schema.js";
export { recordCalendarDate, recordInTimezone } from "./record-date.js";

export function recordCalendarDateSql(timezone: string): SQL {
  return sql`case
    when ${healthRecords.timePrecision} = 'instant' and ${healthRecords.dateBasis} = 'wake_date'
      then coalesce((${healthRecords.endedAt} at time zone ${timezone})::date, ${healthRecords.occurredOn})
    when ${healthRecords.timePrecision} = 'instant' and ${healthRecords.occurredAt} is not null
      then (${healthRecords.occurredAt} at time zone ${timezone})::date
    else ${healthRecords.occurredOn}
  end`;
}
