"use client";

import { SecondaryItems } from "@avgeek-oss/design-system/navigation/secondary-sidebar";
import BookOpen01Icon from "@hugeicons/core-free-icons/BookOpen01Icon";
import UserAccountIcon from "@hugeicons/core-free-icons/UserAccountIcon";
import Key01Icon from "@hugeicons/core-free-icons/Key01Icon";
import Settings01Icon from "@hugeicons/core-free-icons/Settings01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { usePathname } from "next/navigation";

export function AccountSettingsNavigation() {
  const pathname = usePathname();
  return (
    <>
      <SecondaryItems
        title="Account"
        selected={pathname.split("/").at(-1) ?? ""}
        items={[
          {
            id: "profile",
            href: "/settings/profile",
            label: "Profile",
            icon: <HugeiconsIcon icon={UserAccountIcon} size={16} />,
          },
          {
            id: "preferences",
            href: "/settings/preferences",
            label: "Preferences",
            icon: <HugeiconsIcon icon={Settings01Icon} size={16} />,
          },
        ]}
      />
      <SecondaryItems
        title="API & MCP"
        selected={pathname.split("/").at(-1) ?? ""}
        items={[
          {
            id: "api-keys",
            href: "/settings/api-keys",
            label: "API Keys",
            icon: <HugeiconsIcon icon={Key01Icon} size={16} />,
          },
          {
            id: "mcp",
            href: "/settings/mcp",
            label: "MCP Guide",
            icon: <HugeiconsIcon icon={BookOpen01Icon} size={16} />,
          },
        ]}
      />
    </>
  );
}
