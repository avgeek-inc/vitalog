import type { Metadata } from "next";
import { ApiKeyPage } from "../../components/api-key-page";
import { webConfiguration } from "../../lib/config";

export const metadata: Metadata = { title: "Generate an API key" };

export default function Page() {
  return <ApiKeyPage apiBaseUrl={webConfiguration().apiBaseUrl} />;
}
