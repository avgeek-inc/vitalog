"use client";
import { ProfileSettings } from "@avgeek-oss/design-system/patterns/account-settings/profile-settings";
import { PreferencesSettings } from "@avgeek-oss/design-system/patterns/account-settings/preferences-settings";
import { ApplicationPage } from "@avgeek-oss/design-system/patterns/pages/page";
import { ProfileImageSettings } from "@avgeek-oss/design-system/patterns/account-settings/profile-image-settings";
import { SettingsPageTitle } from "@avgeek-oss/design-system/patterns/settings/page-title";
import { useRouter } from "next/navigation";
import { useAccount } from "./account-context";
import { formatDateTime, type Preferences } from "../lib/date-time";
import type { DateTimePreferenceOptions } from "@avgeek-oss/design-system/patterns/settings/date-time-preference-fields";

async function save(path: string, method: string, value: unknown) {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? "Your session expired. Sign in again."
        : "Unable to save changes. Try again.",
    );
}
export function ProfilePage() {
  const account = useAccount();
  const router = useRouter();
  return (
    <ApplicationPage
      title="Profile"
      titleContent={<SettingsPageTitle section="profile" />}
      breadcrumbAncestors={[{ label: "Settings" }, { label: "Account" }]}
    >
      <div className="content-grid min-w-0 lg:grid-cols-2 lg:items-start">
        <ProfileImageSettings name={account.name} email={account.email} />
        <ProfileSettings
          key={account.name}
          value={account.name}
          label="Your Name"
          onSave={async (name) => {
            await save("/auth/profile", "PATCH", { name });
            router.refresh();
          }}
        />
      </div>
    </ApplicationPage>
  );
}
export function PreferencesPage({
  options,
  instant,
}: {
  options: DateTimePreferenceOptions;
  instant: string;
}) {
  const account = useAccount();
  const router = useRouter();
  return (
    <ApplicationPage
      title="Preferences"
      titleContent={<SettingsPageTitle section="preferences" />}
      breadcrumbAncestors={[{ label: "Settings" }, { label: "Account" }]}
    >
      <div className="content-grid min-w-0 lg:grid-cols-2 lg:items-start">
        <PreferencesSettings
          key={JSON.stringify(account.preferences)}
          value={account.preferences}
          options={options}
          formatPreview={(preferences) =>
            formatDateTime(instant, preferences as Preferences).dateTime
          }
          onSave={async (preferences) => {
            await save("/auth/preferences", "PUT", preferences);
            router.refresh();
          }}
        />
      </div>
    </ApplicationPage>
  );
}
