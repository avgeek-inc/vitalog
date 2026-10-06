import type { Metadata } from "next";
import { ApiKeySettings } from "../../../../components/api-key-settings";
export const metadata: Metadata = { title: "API Keys" };
export default function Page() {
  return <ApiKeySettings />;
}
