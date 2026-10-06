"use client";

import { Field } from "@avgeek-oss/design-system/forms/field";
import { Label } from "@avgeek-oss/design-system/forms/label";
import { Textarea } from "@avgeek-oss/design-system/forms/textarea";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { AuthScreen } from "@avgeek-oss/design-system/patterns/auth/auth-screen";
import { useEffect, useId, useRef, useState } from "react";
import { Brand } from "./brand";
import { CredentialsForm, type Credentials } from "./credentials-form";
import { Button } from "./ui/button";

type GeneratedKey = { api_key: string; expires_at: string };

function generationError(status: number) {
  if (status === 401) return "Invalid credentials";
  if (status === 429) return "Too many attempts. Wait a minute and try again.";
  if (status === 503)
    return "Key generation is unavailable. Check the root configuration.";
  return "The key could not be generated. Try again.";
}

export function ApiKeyPage({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [result, setResult] = useState<GeneratedKey>();
  const keyId = useId();
  const keyInput = useRef<HTMLTextAreaElement>(null);
  const resultPanel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (result) resultPanel.current?.focus();
  }, [result]);
  useEffect(() => {
    const clear = () => {
      if (keyInput.current) keyInput.current.value = "";
      setResult(undefined);
    };
    window.addEventListener("pagehide", clear);
    return () => window.removeEventListener("pagehide", clear);
  }, []);

  async function generate(credentials: Credentials) {
    const response = await fetch(apiBaseUrl + "/auth/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credentials),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    }).catch(() => {
      throw new Error(
        "Unable to connect. Check your connection and try again.",
      );
    });
    if (!response.ok) throw new Error(generationError(response.status));
    const data: GeneratedKey = await response.json();
    setResult({ api_key: data.api_key, expires_at: data.expires_at });
  }

  async function copy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.api_key);
      toast.success("API key copied.");
    } catch {
      keyInput.current?.focus();
      keyInput.current?.select();
      toast.warning("Select the key and copy it manually.");
    }
  }

  return (
    <main className="vitalog-auth">
      <AuthScreen
        brand={<Brand />}
        title={result ? "Your API key is ready" : "Generate an API key"}
        description={
          result ? "Copy this key now. It will only be shown once." : undefined
        }
      >
        {result ? (
          <div
            ref={resultPanel}
            tabIndex={-1}
            aria-label="Your new API key"
            className="content-grid outline-none"
          >
            <Field>
              <Label htmlFor={keyId}>API key</Label>
              <Textarea
                id={keyId}
                name="api-key"
                ref={keyInput}
                readOnly
                value={result.api_key}
                className="key-value"
                variant="secondary"
                autoComplete="off"
                spellCheck={false}
                rows={3}
              />
            </Field>
            <p className="text-sm text-muted">
              Expires{" "}
              <time dateTime={result.expires_at}>
                {new Date(result.expires_at).toLocaleString(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </time>
            </p>
            <div className="key-actions">
              <Button onPress={copy}>Copy API key</Button>
              <Button variant="secondary" onPress={() => setResult(undefined)}>
                Generate another key
              </Button>
            </div>
          </div>
        ) : (
          <CredentialsForm
            onSubmit={generate}
            submitLabel="Generate API key"
            busyLabel="Generating key…"
          />
        )}
      </AuthScreen>
    </main>
  );
}
