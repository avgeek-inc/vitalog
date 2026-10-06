import { DashboardShell } from "../../components/dashboard-shell";
import { requireSession } from "../../lib/session";
export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { account } = await requireSession();
  return <DashboardShell account={account}>{children}</DashboardShell>;
}
