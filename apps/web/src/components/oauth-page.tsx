"use client";

import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { AuthScreen } from "@avgeek-oss/design-system/patterns/auth/auth-screen";
import { useEffect, useState } from "react";
import { authorizationCallback } from "../lib/oauth";
import { Brand } from "./brand";
import { CredentialsForm, type Credentials } from "./credentials-form";
import { Button } from "./ui/button";

type ConnectionRequest = {
  client_id: string;
  client_name: string;
  redirect_uri: string;
  scopes: string[];
  csrf_token: string;
};

export function OAuthPage({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [connection, setConnection] = useState<ConnectionRequest>();
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(apiBaseUrl + "/oauth/request", {
          cache: "no-store",
          credentials: "include",
          redirect: "error",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Invalid connection");
        setConnection(await response.json());
      } catch {
        if (!controller.signal.aborted)
          toast.danger("Connection expired", {
            description: "Restart the connection from your MCP client.",
            timeout: 0,
          });
      }
    }
    void load();
    return () => controller.abort();
  }, [apiBaseUrl]);
  const title = connection
    ? `Connect ${connection.client_name}`
    : "Connect to Vitalog";
  useEffect(() => {
    document.title = `${title} · Vitalog`;
  }, [title]);
  const callback = connection ? new URL(connection.redirect_uri) : undefined;
  let clientHost: string | undefined;
  try {
    if (connection?.client_id.startsWith("https://"))
      clientHost = new URL(connection.client_id).host;
  } catch {}

  async function approve(action: "allow" | "deny", credentials?: Credentials) {
    if (!connection || pending) return;
    setPending(true);
    try {
      const response = await fetch(apiBaseUrl + "/oauth/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          csrf_token: connection.csrf_token,
          action,
          ...(action === "allow" ? credentials : {}),
        }),
        cache: "no-store",
        credentials: "include",
        redirect: "error",
      }).catch(() => {
        throw new Error(
          "Unable to connect. Check your connection and try again.",
        );
      });
      if (!response.ok)
        throw new Error(
          response.status === 401
            ? "Invalid credentials"
            : response.status === 429
              ? "Too many attempts. Wait a minute and try again."
              : response.status === 503
                ? "Sign-in is unavailable. Check the root configuration."
                : "The connection could not be completed. Restart from your MCP client.",
        );
      const result: { redirect_to: string } = await response.json();
      window.location.assign(
        authorizationCallback(
          apiBaseUrl,
          connection.redirect_uri,
          result.redirect_to,
          action,
        ),
      );
    } finally {
      setPending(false);
    }
  }
  const permission =
    connection?.scopes.includes("health:read") &&
    connection.scopes.includes("health:write")
      ? "read and update"
      : connection?.scopes.includes("health:write")
        ? "update"
        : "read";
  return (
    <main className="vitalog-auth">
      <AuthScreen
        brand={<Brand />}
        title={title}
        description={
          connection
            ? `Allow ${connection.client_name} to ${permission} your health ledger for 30 days.`
            : undefined
        }
      >
        {clientHost ? (
          <p className="text-center text-sm text-muted break-words">
            Application: {clientHost}
          </p>
        ) : null}
        <CredentialsForm
          isDisabled={!connection || pending}
          submitLabel={title}
          busyLabel="Connecting…"
          submitButtonClassName="h-auto min-h-11 whitespace-normal wrap-anywhere py-3"
          onSubmit={(credentials) => approve("allow", credentials)}
        />
        <div className="key-actions">
          <Button
            variant="secondary"
            fullWidth
            isDisabled={!connection || pending}
            onPress={async () => {
              try {
                await approve("deny");
              } catch (cause) {
                toast.danger(
                  cause instanceof Error
                    ? cause.message
                    : "Unable to connect. Try again.",
                );
              }
            }}
          >
            Cancel
          </Button>
          {callback ? (
            <p className="text-center text-sm text-accent break-words underline underline-offset-4">
              Return to {callback.host || connection?.redirect_uri}
            </p>
          ) : null}
        </div>
      </AuthScreen>
    </main>
  );
}
