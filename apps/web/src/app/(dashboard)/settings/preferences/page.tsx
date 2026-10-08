import { PreferencesPage } from "../../../../components/account-settings";
import {
  dateFormatOptions,
  timeFormatOptions,
} from "@avgeek-oss/design-system/utilities/date-time-preferences";
import { availableTimeZones } from "../../../../../../../src/auth/account-contracts";
export const metadata = { title: "Preferences" };
export default function Preferences() {
  const timeZones = availableTimeZones().sort((left, right) =>
    left === "UTC" ? -1 : right === "UTC" ? 1 : left.localeCompare(right),
  );
  return (
    <PreferencesPage
      options={{
        dateFormats: [...dateFormatOptions],
        timeFormats: [...timeFormatOptions],
        timeZones,
      }}
    />
  );
}
