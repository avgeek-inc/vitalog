import type { Metadata } from "next";
import { DailyScreen } from "../../../components/daily-screen";
export const metadata: Metadata = { title: "Daily View" };
export default async function Daily({
  searchParams,
}: {
  searchParams: Promise<{ date?: string | string[] }>;
}) {
  return <DailyScreen requestedDate={(await searchParams).date} />;
}
