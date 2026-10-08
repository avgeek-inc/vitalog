"use client";
import { ProfileSettings } from "@avgeek-oss/design-system/patterns/account-settings/profile-settings";
import { PreferencesSettings } from "@avgeek-oss/design-system/patterns/account-settings/preferences-settings";
import { ApplicationPage } from "@avgeek-oss/design-system/patterns/pages/page";
import { SettingsPageTitle } from "@avgeek-oss/design-system/patterns/settings/page-title";
import { useAccount, useUpdateAccount } from "./account-context";
import type { Account } from "../../../../src/auth/account-contracts";
import type { DateTimePreferenceOptions } from "@avgeek-oss/design-system/patterns/settings/date-time-preference-fields";
import { apiFetch } from "../lib/browser-api";

async function save(path: string, method: string, value: unknown) {
  const response = await apiFetch(path, {
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
  return (await response.json()) as Account;
}
export function ProfilePage() {
  const account = useAccount();
  const updateAccount = useUpdateAccount();
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
          value={account.name}
          label="Your Name"
          onSave={async (name) => {
            updateAccount(await save("/auth/profile", "PATCH", { name }));
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
  const updateAccount = useUpdateAccount();
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
          value={account.preferences}
          options={options}
          onSave={async (preferences) => {
            updateAccount(await save("/auth/preferences", "PUT", preferences));
          }}
        />
      </div>
    </ApplicationPage>
  );
}
