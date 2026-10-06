import { PreferencesPage } from "../../../../components/account-settings";
import {
  dateFormatOptions,
  timeFormatOptions,
  availableTimeZones,
} from "../../../../../../../src/auth/account-contracts";
import { requireSession } from "../../../../lib/session";
export const metadata = { title: "Preferences" };
export default async function Preferences() {
  const { account } = await requireSession();
  const timeZones = [
    ...new Set([...availableTimeZones(), account.preferences.timeZone]),
  ].sort((left, right) =>
    left === "UTC" ? -1 : right === "UTC" ? 1 : left.localeCompare(right),
  );
  return (
    <PreferencesPage
      instant={new Date().toISOString()}
      options={{
        dateFormats: [...dateFormatOptions],
        timeFormats: [...timeFormatOptions],
        timeZones,
      }}
    />
  );
}
