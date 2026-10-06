"use client";

// Adapted from Mill's Apache-2.0 MCP guide composition. See ui/NOTICE.md.
import BookOpen01Icon from "@hugeicons/core-free-icons/BookOpen01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { Label, ListBox, Select } from "@heroui/react";
import Link from "next/link";
import { useState } from "react";
import { McpClientLogo } from "./mcp-client-logo";
import { ButtonLink } from "./ui/button";
import { CodeBlock } from "./ui/code-block";
import { PageHeading } from "./ui/page-heading";
import { Widget } from "./ui/widget";

const clients = [
  ["codex", "Codex"],
  ["claude", "Claude Code"],
  ["cursor", "Cursor"],
  ["vscode", "VS Code"],
  ["other", "Other clients"],
] as const;
type Client = (typeof clients)[number][0];

export function McpGuide({
  endpoint,
  docsUrl,
}: {
  endpoint: string;
  docsUrl: string;
}) {
  const [client, setClient] = useState<Client>("cursor");
  const clientName = clients.find(([id]) => id === client)![1];
  const configs = {
    codex: {
      title: "~/.codex/config.toml",
      code: `[mcp_servers.vitalog]\nurl = ${JSON.stringify(endpoint)}`,
      help: (
        <>
          Save the configuration, then run <code>codex mcp login vitalog</code>{" "}
          to sign in.
        </>
      ),
    },
    claude: {
      title: "Claude Code",
      code: `claude mcp add --transport http vitalog '${endpoint}'`,
      help: (
        <>
          Run the command, then open <code>/mcp</code> in Claude Code and select
          Vitalog to sign in.
        </>
      ),
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
  const config = configs[client];
  return (
    <section className="min-w-0">
      <PageHeading
        title="MCP Guide"
        icon={<HugeiconsIcon icon={BookOpen01Icon} />}
      />
      <Widget aria-label="Connect your MCP client" role="region">
        <Widget.Header>
          <Widget.Title>
            <h2>Connect your MCP client</h2>
          </Widget.Title>
        </Widget.Header>
        <Widget.Content>
          <div className="content-grid min-w-0">
            <Select
              className="max-w-sm"
              fullWidth
              variant="secondary"
              value={client}
              onChange={(value) => {
                if (
                  typeof value === "string" &&
                  clients.some(([id]) => id === value)
                )
                  setClient(value as Client);
              }}
            >
              <Label>Client</Label>
              <Select.Trigger className="items-center">
                <Select.Value className="flex items-center">
                  <span className="flex items-center gap-2">
                    <McpClientLogo client={client} className="size-5" />
                    {clientName}
                  </span>
                </Select.Value>
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover className="w-(--trigger-width)">
                <ListBox>
                  {clients.map(([id, name]) => (
                    <ListBox.Item key={id} id={id} textValue={name}>
                      <span className="flex min-w-0 flex-1 items-center gap-2 font-medium">
                        <McpClientLogo client={id} className="size-5" />
                        {name}
                      </span>
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
            <CodeBlock>
              <CodeBlock.Header
                endContent={
                  <CodeBlock.CopyButton key={client} code={config.code} />
                }
              >
                <CodeBlock.Filename>{config.title}</CodeBlock.Filename>
              </CodeBlock.Header>
              <CodeBlock.Code
                code={config.code}
                tabIndex={0}
                aria-label="MCP configuration"
              />
            </CodeBlock>
            {"help" in config ? (
              <p className="text-sm leading-relaxed text-muted">
                {config.help}
              </p>
            ) : null}
            <p className="text-sm leading-relaxed text-muted">
              To connect by signing in, add the MCP URL to your app, sign in to
              Vitalog and approve access. Reconnect after 30 days. You can
              revoke access in your personal{" "}
              <Link href="/settings/api-keys" className="text-accent underline">
                API keys
              </Link>
              . The configurations above use OAuth.
            </p>
            <ButtonLink
              href={docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              variant="secondary"
              className="w-fit"
            >
              <HugeiconsIcon aria-hidden="true" icon={BookOpen01Icon} />
              MCP setup and troubleshooting
            </ButtonLink>
          </div>
        </Widget.Content>
      </Widget>
    </section>
  );
}
