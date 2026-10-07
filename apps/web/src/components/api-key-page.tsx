"use client";

import {
  CreateApiKeyDialog,
  apiKeyPermissionOptions,
  apiKeyExpiryOptions,
  type CreateApiKeyValues,
} from "@avgeek-oss/design-system/patterns/account-settings/create-api-key-dialog";
import { Field } from "@avgeek-oss/design-system/forms/field";
import { Input } from "@avgeek-oss/design-system/forms/input";
import { Label } from "@avgeek-oss/design-system/forms/label";
import { AuthScreen } from "@avgeek-oss/design-system/patterns/auth/auth-screen";
import { useEffect, useId, useRef, useState } from "react";
import { Brand } from "./brand";
import { Button } from "./ui/button";

export function ApiKeyPage({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const emailId = useId();
  const passwordId = useId();
  const creationAttempt = useRef<
    { fingerprint: string; requestId: string; body: string } | undefined
  >(undefined);
  useEffect(() => {
    const clear = () => {
      setPassword("");
      setOpen(false);
    };
    window.addEventListener("pagehide", clear);
    return () => window.removeEventListener("pagehide", clear);
  }, []);
  async function generate(values: CreateApiKeyValues) {
    const fingerprint = JSON.stringify(values);
    if (creationAttempt.current?.fingerprint !== fingerprint)
      creationAttempt.current = {
        fingerprint,
        requestId: crypto.randomUUID(),
        body: JSON.stringify({
          name: values.name,
          access: values.permission === "read" ? "read" : "edit",
          includeAdmin: values.permission === "admin",
          expiresAt:
            values.expiry === "never"
              ? null
              : new Date(
                  Date.now() + Number(values.expiry) * 86400000,
                ).toISOString(),
        }),
      };
    const attempt = creationAttempt.current;
    try {
      const response = await fetch(apiBaseUrl + "/auth/api-keys", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": attempt.requestId,
        },
        body: JSON.stringify({ ...JSON.parse(attempt.body), email, password }),
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
      });
      if (!response.ok)
        throw new Error(
          response.status === 401
            ? "Invalid credentials"
            : response.status === 429
              ? "Too many attempts. Wait a minute and try again."
              : "The key could not be generated. Try again.",
        );
      const result: { api_key: string | null } = await response.json();
      return { token: result.api_key };
    } finally {
      setPassword("");
    }
  }
  return (
    <main className="vitalog-auth">
      <AuthScreen
        brand={<Brand />}
        title="Generate an API key"
        description="Choose a name, permissions and expiry, then verify your identity."
      >
        <Button onPress={() => setOpen(true)}>Create API key</Button>
        <CreateApiKeyDialog
          isOpen={open}
          onOpenChange={(value) => {
            setOpen(value);
            if (!value) creationAttempt.current = undefined;
            if (!value) setPassword("");
          }}
          permissionOptions={apiKeyPermissionOptions}
          expiryOptions={apiKeyExpiryOptions}
          onCreate={generate}
        >
          <div className="grid gap-4">
            <Field>
              <Label htmlFor={emailId} isRequired>
                Email
              </Label>
              <Input
                id={emailId}
                name="email"
                type="email"
                required
                maxLength={254}
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.currentTarget.value)}
                variant="secondary"
              />
            </Field>
            <Field>
              <Label htmlFor={passwordId} isRequired>
                Password
              </Label>
              <Input
                id={passwordId}
                name="password"
                type="password"
                required
                maxLength={256}
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.currentTarget.value)}
                variant="secondary"
              />
            </Field>
          </div>
        </CreateApiKeyDialog>
      </AuthScreen>
    </main>
  );
}
