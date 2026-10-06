"use client";

import {
  SecondaryEntityHeader,
  SecondaryItems,
} from "@avgeek-oss/design-system/navigation/secondary-sidebar";
import BookOpen01Icon from "@hugeicons/core-free-icons/BookOpen01Icon";
import Key01Icon from "@hugeicons/core-free-icons/Key01Icon";
import Settings01Icon from "@hugeicons/core-free-icons/Settings01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { usePathname } from "next/navigation";

export function AccountSettingsNavigation() {
  const pathname = usePathname();
  return (
    <>
      <SecondaryEntityHeader
        title="Account settings"
        icon={<HugeiconsIcon icon={Settings01Icon} size={18} />}
      >
        Account settings
      </SecondaryEntityHeader>
      <SecondaryItems
        selected={pathname.endsWith("/mcp") ? "mcp" : "api-keys"}
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
