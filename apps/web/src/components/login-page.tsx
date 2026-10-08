"use client";

import {
  SignIn,
  type SignInProps,
} from "@avgeek-oss/design-system/patterns/auth/sign-in";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { useEffect } from "react";
import { Brand } from "./brand";

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
  const signIn: SignInProps["onSubmit"] = async ({ identifier, password }) => {
    let response: Response;
    try {
      response = await fetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: identifier, password }),
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
  };
  return (
    <main className="vitalog-auth">
      <SignIn brand={<Brand />} onSubmit={signIn} />
    </main>
  );
}
