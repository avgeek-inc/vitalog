import type { Metadata } from "next";
import { OAuthPage } from "../../../components/oauth-page";
import { webConfiguration } from "../../../lib/config";

export const metadata: Metadata = { title: "Connect ChatGPT" };

export default function Page() {
  return <OAuthPage apiBaseUrl={webConfiguration().apiBaseUrl} />;
}
