import type { Metadata } from "next";
import { McpGuide } from "../../../../components/mcp-guide";
import { mcpDocumentationUrl, webConfiguration } from "../../../../lib/config";
export const metadata: Metadata = { title: "MCP Guide" };
export default function Page() {
  return (
    <McpGuide
      endpoint={webConfiguration().apiBaseUrl + "/mcp"}
      docsUrl={mcpDocumentationUrl()}
    />
  );
}
