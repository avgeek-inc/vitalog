import {
  Button,
  Card,
  FieldError,
  Form,
  Input,
  Label,
  TextArea,
  TextField,
} from "@heroui/react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Brand } from "./brand";

type GeneratedKey = { api_key: string; expires_at: string };

function generationError(status: number) {
  if (status === 401) return "Check your email and password and try again.";
  if (status === 429) return "Too many attempts. Wait a minute and try again.";
  if (status === 503)
    return "Key generation is unavailable. Check the root configuration.";
  return "The key could not be generated. Try again.";
}

export function ApiKeyPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [invalidCredentials, setInvalidCredentials] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<GeneratedKey>();
  const [copyStatus, setCopyStatus] = useState("");
  const passwordInput = useRef<HTMLInputElement>(null);
  const keyInput = useRef<HTMLTextAreaElement>(null);
  const resultPanel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (result) resultPanel.current?.focus();
  }, [result]);

  useEffect(() => {
    const clearSecrets = () => {
      if (passwordInput.current) passwordInput.current.value = "";
      if (keyInput.current) keyInput.current.value = "";
      setPassword("");
      setResult(undefined);
      setCopyStatus("");
    };
    window.addEventListener("pagehide", clearSecrets);
    return () => window.removeEventListener("pagehide", clearSecrets);
  }, []);

  function clearError() {
    setError(undefined);
    setInvalidCredentials(false);
  }

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    clearError();
    setIsSubmitting(true);
    try {
      const response = await fetch("/auth/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
        }),
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
      });
      if (!response.ok) {
        setInvalidCredentials(response.status === 401);
        setError(generationError(response.status));
        return;
      }
      const data: GeneratedKey = await response.json();
      setResult({ api_key: data.api_key, expires_at: data.expires_at });
    } catch {
      setError("Unable to connect. Check your connection and try again.");
    } finally {
      setPassword("");
      setIsSubmitting(false);
    }
  }

  async function copy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.api_key);
      setCopyStatus("API key copied.");
    } catch {
      keyInput.current?.focus();
      keyInput.current?.select();
      setCopyStatus("Select and copy the API key above.");
    }
  }

  function generateAnother() {
    setResult(undefined);
    setCopyStatus("");
    requestAnimationFrame(() => passwordInput.current?.focus());
  }

  return (
    <main className="key-page">
      <div className="key-page-content">
        <Brand />
        <Card className="key-card" aria-label="API key generation">
          <Card.Header className="gap-2">
            <h1 className="page-title">
              {result ? "Your API key is ready" : "Generate an API key"}
            </h1>
            {result ? (
              <Card.Description className="text-base leading-6">
                Copy this key now. It will only be shown once.
              </Card.Description>
            ) : null}
          </Card.Header>
          <Card.Content>
            {result ? (
              <div
                ref={resultPanel}
                tabIndex={-1}
                aria-label="Your new API key"
                className="grid gap-5 outline-none"
              >
                <TextField name="api-key" isReadOnly value={result.api_key}>
                  <Label>API key</Label>
                  <TextArea
                    ref={keyInput}
                    className="key-value"
                    variant="secondary"
                    autoComplete="off"
                    spellCheck={false}
                    rows={3}
                  />
                </TextField>
                <p className="text-sm leading-6 text-muted">
                  Expires{" "}
                  <time dateTime={result.expires_at}>
                    {new Date(result.expires_at).toLocaleString(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </time>
                </p>
                <div className="key-actions">
                  <Button type="button" onPress={copy}>
                    Copy API key
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onPress={generateAnother}
                  >
                    Generate another key
                  </Button>
                </div>
                <p
                  className="text-sm text-muted"
                  role="status"
                  aria-live="polite"
                >
                  {copyStatus}
                </p>
              </div>
            ) : (
              <Form
                className="grid gap-5"
                action="/auth/api-keys"
                method="post"
                onSubmit={generate}
                aria-busy={isSubmitting}
              >
                <TextField
                  name="email"
                  type="email"
                  autoComplete="username"
                  isRequired
                  isInvalid={invalidCredentials || undefined}
                  isDisabled={isSubmitting}
                  value={email}
                  onChange={(value) => {
                    setEmail(value);
                    clearError();
                  }}
                >
                  <Label>Root email</Label>
                  <Input
                    variant="secondary"
                    maxLength={254}
                    aria-describedby={error ? "form-error" : undefined}
                  />
                  {!isSubmitting ? <FieldError /> : null}
                </TextField>
                <TextField
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  isRequired
                  isInvalid={invalidCredentials || undefined}
                  isDisabled={isSubmitting}
                  value={password}
                  onChange={(value) => {
                    setPassword(value);
                    clearError();
                  }}
                >
                  <Label>Root password</Label>
                  <Input
                    ref={passwordInput}
                    variant="secondary"
                    maxLength={256}
                    aria-describedby={error ? "form-error" : undefined}
                  />
                  {!isSubmitting ? <FieldError /> : null}
                </TextField>
                {error ? (
                  <p
                    id="form-error"
                    className="text-sm leading-6 text-danger"
                    role="alert"
                  >
                    Error: {error}
                  </p>
                ) : null}
                <Button type="submit" fullWidth isPending={isSubmitting}>
                  {isSubmitting ? "Generating key…" : "Generate API key"}
                </Button>
              </Form>
            )}
          </Card.Content>
        </Card>
      </div>
    </main>
  );
}
