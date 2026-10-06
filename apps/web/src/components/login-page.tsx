"use client";

import { AuthScreen } from "@avgeek-oss/design-system/patterns/auth/auth-screen";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { useEffect } from "react";
import { Brand } from "./brand";
import { CredentialsForm, type Credentials } from "./credentials-form";

export function LoginPage({
  localSignOut = false,
}: {
  localSignOut?: boolean;
}) {
  useEffect(() => {
    if (localSignOut)
      toast.warning(
        "Signed out on this browser. The session could not be revoked.",
      );
  }, [localSignOut]);
  async function signIn(credentials: Credentials) {
    let response: Response;
    try {
      response = await fetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentials),
        cache: "no-store",
        redirect: "error",
      });
    } catch {
      throw new Error("Unable to connect. Try again.");
    }
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? "Invalid credentials"
          : response.status === 429
            ? "Too many attempts. Wait a minute and try again."
            : "Unable to sign in. Try again.",
      );
    window.location.assign("/daily");
  }
  return (
    <main className="vitalog-auth">
      <AuthScreen
        brand={<Brand />}
        title="Sign in to Vitalog"
        description="See your day, one log at a time."
      >
        <CredentialsForm
          onSubmit={signIn}
          submitLabel="Sign in"
          busyLabel="Signing in…"
        />
      </AuthScreen>
    </main>
  );
}
