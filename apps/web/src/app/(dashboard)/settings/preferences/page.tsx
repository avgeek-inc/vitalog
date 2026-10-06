import { PreferencesPage } from "../../../../components/account-settings";
import {
  dateFormatOptions,
  timeFormatOptions,
  isTimeZone,
} from "../../../../../../../src/auth/account-contracts";
import { requireSession } from "../../../../lib/session";
export const metadata = { title: "Preferences" };
export default async function Preferences() {
  const { account } = await requireSession();
  const timeZones = [
    ...new Set(
      [
        "UTC",
        ...Intl.supportedValuesOf("timeZone"),
        "Asia/Kolkata",
        "Asia/Kathmandu",
        "Asia/Yangon",
        "Europe/Kyiv",
        "America/Nuuk",
        "Pacific/Kanton",
        account.preferences.timeZone,
      ].filter(isTimeZone),
    ),
  ].sort();
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
