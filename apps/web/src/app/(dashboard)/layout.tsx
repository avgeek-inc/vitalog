import { DashboardShell } from "../../components/dashboard-shell";
import { requireSession } from "../../lib/session";
export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireSession();
  return <DashboardShell>{children}</DashboardShell>;
}
