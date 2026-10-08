import { DashboardSession } from "../../components/dashboard-session";
import { documentationUrl } from "../../lib/config";
export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <DashboardSession docsUrl={documentationUrl()}>{children}</DashboardSession>
  );
}
