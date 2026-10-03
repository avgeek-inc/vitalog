import {
  Button,
  Card,
  FieldError,
  Form,
  Input,
  Label,
  TextField,
} from "@heroui/react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Brand } from "./brand";

type ConnectionRequest = {
  client_name: string;
  scopes: string[];
  csrf_token: string;
};

export function OAuthPage() {
  const [connection, setConnection] = useState<ConnectionRequest>();
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const keyInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = "Connect ChatGPT · Vitalog";
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/oauth/request", {
          cache: "no-store",
          credentials: "same-origin",
          redirect: "error",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Invalid connection");
        const request: ConnectionRequest = await response.json();
        setConnection(request);
      } catch {
        if (!controller.signal.aborted)
          setError("This connection request expired. Restart from ChatGPT.");
      }
    }
    void load();
    const clear = () => {
      if (keyInput.current) keyInput.current.value = "";
      setApiKey("");
    };
    window.addEventListener("pagehide", clear);
    return () => {
      controller.abort();
      window.removeEventListener("pagehide", clear);
    };
  }, []);

  async function approve(action: "allow" | "deny") {
    if (!connection || pending) return;
    setPending(true);
    setError(undefined);
    try {
      const response = await fetch("/oauth/approve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(action === "allow"
            ? { Authorization: "Bearer " + apiKey.trim() }
            : {}),
        },
        body: JSON.stringify({ csrf_token: connection.csrf_token, action }),
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
      });
      if (!response.ok) {
        setError(
          response.status === 401
            ? "Use an active API key and try again."
            : response.status === 429
              ? "Too many attempts. Wait a minute and try again."
              : "The connection could not be completed. Restart from ChatGPT.",
        );
        return;
      }
      const result: { redirect_to: string } = await response.json();
      const redirect = new URL(result.redirect_to);
      if (
        redirect.origin !== "https://chatgpt.com" ||
        redirect.pathname !== "/connector_platform_oauth_redirect"
      )
        throw new Error("Invalid callback");
      window.location.assign(redirect.toString());
    } catch {
      setError("Unable to connect. Check your connection and try again.");
    } finally {
      setApiKey("");
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
        <Card className="key-card" aria-label="Connect ChatGPT">
          <Card.Header className="gap-2">
            <h1 className="page-title">Connect ChatGPT</h1>
            {connection ? (
              <Card.Description className="text-base leading-6">
                Allow ChatGPT to {permission} your health ledger. Access expires
                with your API key.
              </Card.Description>
            ) : null}
          </Card.Header>
          <Card.Content>
            <Form className="grid gap-5" onSubmit={submit} aria-busy={pending}>
              <TextField
                name="api-key"
                type="password"
                autoComplete="off"
                isRequired
                isDisabled={!connection || pending}
                value={apiKey}
                onChange={(value) => {
                  setApiKey(value);
                  setError(undefined);
                }}
              >
                <Label>API key</Label>
                <Input
                  ref={keyInput}
                  variant="secondary"
                  spellCheck={false}
                  maxLength={128}
                  aria-describedby={error ? "connection-error" : undefined}
                />
                <FieldError />
              </TextField>
              {error ? (
                <p
                  id="connection-error"
                  className="text-sm leading-6 text-danger"
                  role="alert"
                >
                  {error}
                </p>
              ) : null}
              <div className="key-actions">
                <Button
                  type="submit"
                  isDisabled={!connection}
                  isPending={pending}
                >
                  {pending ? "Connecting…" : "Connect ChatGPT"}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  isDisabled={!connection || pending}
                  onPress={() => void approve("deny")}
                >
                  Cancel
                </Button>
              </div>
              <a
                className="text-sm underline underline-offset-4"
                href="/api-keys"
                target="_blank"
                rel="noopener noreferrer"
              >
                Generate an API key
              </a>
            </Form>
          </Card.Content>
        </Card>
      </div>
    </main>
  );
}
