import { DashboardShell } from "../../components/dashboard-shell";
import { requireSession } from "../../lib/session";
import { documentationUrl } from "../../lib/config";
export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { account } = await requireSession();
  return (
    <DashboardShell account={account} docsUrl={documentationUrl()}>
      {children}
    </DashboardShell>
  );
}
