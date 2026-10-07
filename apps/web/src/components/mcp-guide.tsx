"use client";

// Adapted from Mill's Apache-2.0 MCP guide composition. See ui/NOTICE.md.
import { McpGuideSettings } from "@avgeek-oss/design-system/patterns/account-settings/mcp-guide-settings";
import { SettingsPageTitle } from "@avgeek-oss/design-system/patterns/settings/page-title";
import { ApplicationPage } from "@avgeek-oss/design-system/patterns/pages/page";
import { McpClientLogo } from "./mcp-client-logo";

const clients = [
  ["codex", "Codex"],
  ["claude", "Claude Code"],
  ["cursor", "Cursor"],
  ["vscode", "VS Code"],
  ["other", "Other clients"],
] as const;

export function McpGuide({
  endpoint,
  docsUrl,
}: {
  endpoint: string;
  docsUrl: string;
}) {
  const configs = {
    codex: {
      title: "~/.codex/config.toml",
      code: `[mcp_servers.vitalog]\nurl = ${JSON.stringify(endpoint)}`,
    },
    claude: {
      title: "Claude Code",
      code: `claude mcp add --transport http vitalog '${endpoint}'`,
    },
    cursor: {
      title: ".cursor/mcp.json",
      code: JSON.stringify(
        { mcpServers: { vitalog: { url: endpoint } } },
        null,
        2,
      ),
    },
    vscode: {
      title: ".vscode/mcp.json",
      code: JSON.stringify(
        { servers: { vitalog: { type: "http", url: endpoint } } },
        null,
        2,
      ),
    },
    other: {
      title: "Connection details",
      code: `Transport: Streamable HTTP\nURL: ${endpoint}\nAuthentication: OAuth`,
    },
  };
  return (
    <ApplicationPage
      title="MCP Guide"
      titleContent={<SettingsPageTitle section="mcp" />}
      breadcrumbAncestors={[{ label: "Settings" }, { label: "API & MCP" }]}
    >
      <McpGuideSettings
        documentationUrl={docsUrl}
        configurations={clients.map(([id, label]) => ({
          id,
          label,
          filename: configs[id].title,
          code: configs[id].code,
          icon: <McpClientLogo client={id} />,
        }))}
      />
    </ApplicationPage>
  );
}
