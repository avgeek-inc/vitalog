import type { Metadata } from "next";
import { LoginPage } from "../../components/login-page";
export const metadata: Metadata = { title: "Sign in" };
export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ signout?: string }>;
}) {
  return <LoginPage localSignOut={(await searchParams).signout === "local"} />;
}
