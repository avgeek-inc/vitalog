"use client";
import { ProfileSettings } from "@avgeek-oss/design-system/patterns/account-settings/profile-settings";
import { PreferencesSettings } from "@avgeek-oss/design-system/patterns/account-settings/preferences-settings";
import { ApplicationPage } from "@avgeek-oss/design-system/patterns/pages/page";
import { SettingsPageTitle } from "@avgeek-oss/design-system/patterns/settings/page-title";
import { useRouter } from "next/navigation";
import { useAccount } from "./account-context";
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
      breadcrumbAncestors={[
        { label: "Account Settings", href: "/settings/profile" },
      ]}
    >
      <div className="content-grid min-w-0 lg:grid-cols-2 lg:items-start">
        <ProfileSettings
          key={account.name}
          value={account.name}
          email={account.email}
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
}: {
  options: DateTimePreferenceOptions;
}) {
  const account = useAccount();
  const router = useRouter();
  return (
    <ApplicationPage
      title="Preferences"
      titleContent={<SettingsPageTitle section="preferences" />}
      breadcrumbAncestors={[
        { label: "Account Settings", href: "/settings/profile" },
      ]}
    >
      <div className="content-grid min-w-0 lg:grid-cols-2 lg:items-start">
        <PreferencesSettings
          key={JSON.stringify(account.preferences)}
          value={account.preferences}
          options={options}
          onSave={async (preferences) => {
            await save("/auth/preferences", "PUT", preferences);
            router.refresh();
          }}
        />
      </div>
    </ApplicationPage>
  );
}
