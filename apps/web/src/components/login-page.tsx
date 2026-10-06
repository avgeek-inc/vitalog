"use client";

import { Button } from "./ui/button";

import { Card, FieldError, Form, Input, Label, TextField } from "@heroui/react";
import { toast } from "@heroui/react/toast";
import { useEffect, useState, type FormEvent } from "react";
import { Brand } from "./brand";

export function LoginPage({
  localSignOut = false,
}: {
  localSignOut?: boolean;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    if (localSignOut)
      toast.warning(
        "Signed out on this browser. The session could not be revoked.",
      );
  }, [localSignOut]);
  useEffect(() => {
    const clear = () => setPassword("");
    window.addEventListener("pagehide", clear);
    return () => window.removeEventListener("pagehide", clear);
  }, []);
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setInvalid(false);
    try {
      const response = await fetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
        cache: "no-store",
        redirect: "error",
      });
      if (response.ok) {
        window.location.assign("/daily");
        return;
      }
      setInvalid(response.status === 401);
      toast.danger(
        response.status === 401
          ? "Invalid credentials"
          : response.status === 429
            ? "Too many attempts. Wait a minute and try again."
            : "Unable to sign in. Try again.",
      );
    } catch {
      toast.danger("Unable to connect. Try again.");
    } finally {
      setPassword("");
      setPending(false);
    }
  }
  return (
    <main className="key-page">
      <div className="key-page-content">
        <Brand />
        <Card className="key-card" aria-label="Sign in">
          <Card.Header className="key-card-header gap-2">
            <h1 className="page-title">Sign in to Vitalog</h1>
            <Card.Description>
              See your day, one log at a time.
            </Card.Description>
          </Card.Header>
          <Card.Content>
            <Form onSubmit={signIn} className="grid gap-5" aria-busy={pending}>
              <TextField
                name="email"
                type="email"
                autoComplete="username"
                isRequired
                isDisabled={pending}
                isInvalid={invalid || undefined}
                value={email}
                onChange={(value) => {
                  setEmail(value);
                  setInvalid(false);
                }}
              >
                <Label>Email</Label>
                <Input variant="secondary" maxLength={254} />
                <FieldError />
              </TextField>
              <TextField
                name="password"
                type="password"
                autoComplete="current-password"
                isRequired
                isDisabled={pending}
                isInvalid={invalid || undefined}
                value={password}
                onChange={(value) => {
                  setPassword(value);
                  setInvalid(false);
                }}
              >
                <Label>Password</Label>
                <Input variant="secondary" maxLength={256} />
                <FieldError />
              </TextField>
              <Button type="submit" fullWidth isPending={pending}>
                {pending ? "Signing in…" : "Sign in"}
              </Button>
            </Form>
          </Card.Content>
        </Card>
      </div>
    </main>
  );
}
