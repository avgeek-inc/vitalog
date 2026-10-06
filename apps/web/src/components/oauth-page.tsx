"use client";

import { Button } from "./ui/button";

import { Card, FieldError, Form, Input, Label, TextField } from "@heroui/react";
import { toast } from "@heroui/react/toast";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Brand } from "./brand";
import { authorizationCallback } from "../lib/oauth";

type ConnectionRequest = {
  client_id: string;
  client_name: string;
  redirect_uri: string;
  scopes: string[];
  csrf_token: string;
};

export function OAuthPage({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [connection, setConnection] = useState<ConnectionRequest>();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [invalidCredentials, setInvalidCredentials] = useState(false);
  const [pending, setPending] = useState(false);
  const passwordInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = "Connect to Vitalog";
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
        const request: ConnectionRequest = await response.json();
        setConnection(request);
      } catch {
        if (!controller.signal.aborted)
          toast.danger("Connection expired", {
            description: "Restart the connection from your MCP client.",
            timeout: 0,
          });
      }
    }
    void load();
    const clear = () => {
      if (passwordInput.current) passwordInput.current.value = "";
      setPassword("");
    };
    window.addEventListener("pagehide", clear);
    return () => {
      controller.abort();
      window.removeEventListener("pagehide", clear);
    };
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

  async function approve(action: "allow" | "deny") {
    if (!connection || pending) return;
    setPending(true);
    setInvalidCredentials(false);
    try {
      const response = await fetch(apiBaseUrl + "/oauth/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          csrf_token: connection.csrf_token,
          action,
          ...(action === "allow" ? { email, password } : {}),
        }),
        cache: "no-store",
        credentials: "include",
        redirect: "error",
      });
      if (!response.ok) {
        setInvalidCredentials(response.status === 401);
        toast.danger(
          response.status === 401
            ? "Invalid credentials"
            : response.status === 429
              ? "Too many attempts. Wait a minute and try again."
              : response.status === 503
                ? "Sign-in is unavailable. Check the root configuration."
                : "The connection could not be completed. Restart from your MCP client.",
        );
        return;
      }
      const result: { redirect_to: string } = await response.json();
      window.location.assign(
        authorizationCallback(
          apiBaseUrl,
          connection.redirect_uri,
          result.redirect_to,
          action,
        ),
      );
    } catch {
      toast.danger("Unable to connect. Check your connection and try again.");
    } finally {
      setPassword("");
      setPending(false);
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void approve("allow");
  }
  const permission =
    connection?.scopes.includes("health:read") &&
    connection.scopes.includes("health:write")
      ? "read and update"
      : connection?.scopes.includes("health:write")
        ? "update"
        : "read";
  return (
    <main className="key-page">
      <div className="key-page-content">
        <Brand />
        <Card className="key-card" aria-label={title}>
          <Card.Header className="key-card-header gap-2">
            <h1 className="page-title break-words">{title}</h1>
            {connection ? (
              <Card.Description className="text-base leading-6 break-words">
                Allow {connection.client_name} to {permission} your health
                ledger for 30 days.
              </Card.Description>
            ) : null}
            {clientHost ? (
              <p className="text-sm leading-5 text-muted break-words">
                Application: {clientHost}
              </p>
            ) : null}
          </Card.Header>
          <Card.Content>
            <Form className="grid gap-5" onSubmit={submit} aria-busy={pending}>
              <TextField
                name="email"
                type="email"
                autoComplete="username"
                isRequired
                isInvalid={invalidCredentials || undefined}
                isDisabled={!connection || pending}
                value={email}
                onChange={(value) => {
                  setEmail(value);
                  setInvalidCredentials(false);
                }}
              >
                <Label>Root email</Label>
                <Input variant="secondary" maxLength={254} />
                <FieldError />
              </TextField>
              <TextField
                name="password"
                type="password"
                autoComplete="current-password"
                isRequired
                isInvalid={invalidCredentials || undefined}
                isDisabled={!connection || pending}
                value={password}
                onChange={(value) => {
                  setPassword(value);
                  setInvalidCredentials(false);
                }}
              >
                <Label>Root password</Label>
                <Input
                  ref={passwordInput}
                  variant="secondary"
                  maxLength={256}
                />
                <FieldError />
              </TextField>
              <div className="key-actions">
                <Button
                  type="submit"
                  fullWidth
                  isDisabled={!connection}
                  isPending={pending}
                  className="h-auto min-h-11 whitespace-normal py-3"
                >
                  {pending ? "Connecting…" : title}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  fullWidth
                  isDisabled={!connection || pending}
                  onPress={() => void approve("deny")}
                >
                  Cancel
                </Button>
                {callback ? (
                  <p className="text-center text-sm leading-5 text-accent break-words underline underline-offset-4">
                    Return to {callback.host || connection!.redirect_uri}
                  </p>
                ) : null}
              </div>
            </Form>
          </Card.Content>
        </Card>
      </div>
    </main>
  );
}
