"use client";

import BookOpen01Icon from "@hugeicons/core-free-icons/BookOpen01Icon";
import Calendar01Icon from "@hugeicons/core-free-icons/Calendar01Icon";
import Key01Icon from "@hugeicons/core-free-icons/Key01Icon";
import Logout03Icon from "@hugeicons/core-free-icons/Logout03Icon";
import WeightScaleIcon from "@hugeicons/core-free-icons/WeightScaleIcon";
import { HugeiconsIcon } from "@hugeicons/react";
import { toast } from "@heroui/react";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Button } from "./ui/button";
import {
  AppLayout,
  ApplicationNavbar,
  ApplicationSidebar,
  usePersistentAppSidebar,
} from "./ui/shell";

const sections = [
  {
    id: "stats",
    label: "Stats",
    items: [
      {
        id: "daily",
        href: "/daily",
        label: "Daily View",
        icon: Calendar01Icon,
      },
      {
        id: "weight",
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
        id: "api-keys",
        href: "/settings/api-keys",
        label: "API Keys",
        icon: Key01Icon,
      },
      {
        id: "mcp",
        href: "/settings/mcp",
        label: "MCP Guide",
        icon: BookOpen01Icon,
      },
    ],
  },
];

export function DashboardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const sidebarState = usePersistentAppSidebar();
  const group = sections.find((section) =>
    section.items.some((item) => item.href === pathname),
  );
  const item = group?.items.find((item) => item.href === pathname);
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
    <>
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <AppLayout
        {...sidebarState}
        path={pathname}
        navigate={router.push}
        navbar={
          <ApplicationNavbar
            title={
              <>
                <span className="font-normal text-muted">{group?.label}</span>
                <span aria-hidden="true" className="mx-2 text-muted">
                  /
                </span>
                {item?.label}
              </>
            }
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
              brand: {
                title: "Vitalog",
                logo: (
                  <img
                    src="/brand/vitalog-mark.png"
                    width={32}
                    height={32}
                    alt=""
                  />
                ),
              },
              groups: sections.map((section) => ({
                ...section,
                items: section.items.map((entry) => ({
                  ...entry,
                  icon: (
                    <HugeiconsIcon
                      aria-hidden="true"
                      icon={entry.icon}
                      size={16}
                    />
                  ),
                })),
              })),
              footerContent: (
                <Button
                  className="w-full justify-start text-muted"
                  variant="ghost"
                  isPending={pending}
                  onPress={signOut}
                >
                  <HugeiconsIcon aria-hidden="true" icon={Logout03Icon} />
                  Sign out
                </Button>
              ),
            }}
          />
        }
      >
        <div className="dashboard-main">{children}</div>
      </AppLayout>
    </>
  );
}
