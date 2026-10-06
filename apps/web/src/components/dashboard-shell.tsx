"use client";

import { RouteProvider } from "@avgeek-oss/design-system/hooks/route-context";
import {
  AppShell,
  ApplicationNavbar,
  ApplicationSidebar,
  usePersistentAppSidebar,
} from "@avgeek-oss/design-system/layouts/app-shell";
import { AppLayout } from "@avgeek-oss/design-system/navigation/app-layout";
import { SecondarySidebarLayout } from "@avgeek-oss/design-system/navigation/secondary-sidebar";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import Calendar01Icon from "@hugeicons/core-free-icons/Calendar01Icon";
import Logout03Icon from "@hugeicons/core-free-icons/Logout03Icon";
import Settings01Icon from "@hugeicons/core-free-icons/Settings01Icon";
import WeightScaleIcon from "@hugeicons/core-free-icons/WeightScaleIcon";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { AccountSettingsNavigation } from "./account-settings-navigation";

const brand = {
  id: "vitalog",
  accessibleLabel: "Vitalog",
  title: "Vitalog",
  logoSrc: "/brand/vitalog-mark.png",
};

const sections = [
  {
    id: "stats",
    label: "Stats",
    items: [
      {
        id: "daily",
        kind: "link" as const,
        href: "/daily",
        label: "Daily View",
        icon: Calendar01Icon,
      },
      {
        id: "weight",
        kind: "link" as const,
        href: "/weight",
        label: "Weight Management",
        icon: WeightScaleIcon,
      },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    items: [
      {
        id: "account-settings",
        kind: "link" as const,
        href: "/settings/api-keys",
        activePath: "/settings",
        preserveSubroute: true,
        label: "Account settings",
        icon: Settings01Icon,
      },
    ],
  },
];

export function DashboardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const sidebarState = usePersistentAppSidebar("vitalog:sidebar-open");
  async function signOut() {
    if (pending) return;
    setPending(true);
    try {
      const response = await fetch("/auth/logout", {
        method: "POST",
        cache: "no-store",
        redirect: "error",
      });
      if (!response.ok) {
        toast.danger("Unable to sign out. Try again.");
        return;
      }
      const result: { revoked: boolean } = await response.json();
      window.location.assign(
        result.revoked ? "/login" : "/login?signout=local",
      );
    } catch {
      toast.danger("Unable to connect. Try again.");
    } finally {
      setPending(false);
    }
  }
  return (
    <RouteProvider pathname={pathname} navigate={router.push}>
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <AppShell
        contentWidth="broad"
        policy={{ kind: "product", toasts: false, themeControl: "header" }}
      >
        <AppLayout
          {...sidebarState}
          navigate={router.push}
          toggleShortcut
          navbar={
            <ApplicationNavbar
              config={{ brand, homeHref: "/daily" }}
              hasSidebar
              showThemeSwitcher
              sidebarOpen={sidebarState.sidebarOpen}
              onSidebarToggle={() =>
                sidebarState.onSidebarOpenChange(!sidebarState.sidebarOpen)
              }
            />
          }
          sidebar={
            <ApplicationSidebar
              config={{
                accessibleLabel: "Primary navigation",
                homeHref: "/daily",
                brand,
                groups: sections,
                footerActions: [
                  {
                    kind: "action",
                    id: "sign-out",
                    label: pending ? "Signing out…" : "Sign out",
                    icon: Logout03Icon,
                    disabled: pending,
                    onSelect: () => void signOut(),
                  },
                ],
              }}
            />
          }
        >
          <SecondarySidebarLayout>
            {pathname.startsWith("/settings/") ? (
              <AccountSettingsNavigation />
            ) : null}
            <AppShell.Content id="main-content" tabIndex={-1}>
              {children}
            </AppShell.Content>
          </SecondarySidebarLayout>
        </AppLayout>
      </AppShell>
    </RouteProvider>
  );
}
