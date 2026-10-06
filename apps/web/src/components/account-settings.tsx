"use client";
import { ProfileSettings } from "@avgeek-oss/design-system/patterns/account-settings/profile-settings";
import { PreferencesSettings } from "@avgeek-oss/design-system/patterns/account-settings/preferences-settings";
import { ApplicationPage } from "@avgeek-oss/design-system/patterns/pages/page";
import { UserAvatar } from "@avgeek-oss/design-system/patterns/user-avatar";
import { Widget } from "./ui/widget";
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
      breadcrumbAncestors={[{ label: "Settings" }, { label: "Account" }]}
    >
      <div className="content-grid max-w-2xl">
        <Widget>
          <Widget.Header>
            <Widget.Title>Appearance</Widget.Title>
          </Widget.Header>
          <Widget.Content>
            <div className="grid gap-3">
              <span className="text-sm font-medium">Gravatar Image</span>
              <p className="text-sm text-muted">
                Click the image to update it on Gravatar.
              </p>
              <a
                href="https://gravatar.com/profile/avatars"
                target="_blank"
                rel="noopener noreferrer"
                className="w-fit rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
                aria-label="Edit Gravatar image (opens in a new tab)"
              >
                <UserAvatar
                  email={account.email}
                  name={account.name}
                  className="size-12"
                />
              </a>
            </div>
          </Widget.Content>
        </Widget>
        <ProfileSettings
          key={account.name}
          value={account.name}
          label="Full name"
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
      breadcrumbAncestors={[{ label: "Settings" }, { label: "Account" }]}
    >
      <div className="max-w-2xl">
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
