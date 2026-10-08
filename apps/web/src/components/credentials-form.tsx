"use client";

import { AuthForm } from "@avgeek-oss/design-system/patterns/auth/auth-form";
import { useEffect, useRef, useState } from "react";

export type Credentials = { email: string; password: string };

export function CredentialsForm({
  onSubmit,
  submitLabel,
  busyLabel,
  isDisabled = false,
  variant = "primary",
  autoFocus = false,
  submitButtonClassName,
}: {
  onSubmit: (credentials: Credentials) => Promise<void>;
  submitLabel: string;
  busyLabel?: string;
  isDisabled?: boolean;
  variant?: "primary" | "secondary";
  autoFocus?: boolean;
  submitButtonClassName?: string;
}) {
  const [password, setPassword] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const clear = () => {
      if (input.current) input.current.value = "";
      setPassword("");
    };
    window.addEventListener("pagehide", clear);
    return () => window.removeEventListener("pagehide", clear);
  }, []);
  return (
    <fieldset disabled={isDisabled} className="min-w-0">
      <AuthForm
        variant={variant}
        fields={[
          {
            name: "email",
            label: "Email",
            type: "email",
            autoComplete: "username",
            required: true,
            maxLength: 254,
            disabled: isDisabled,
            autoFocus,
          },
          {
            name: "password",
            label: "Password",
            type: "password",
            autoComplete: "current-password",
            required: true,
            maxLength: 256,
            disabled: isDisabled,
            value: password,
            ref: input,
            onChange: (event) => setPassword(event.currentTarget.value),
          },
        ]}
        submitLabel={submitLabel}
        busyLabel={busyLabel}
        submitButtonClassName={submitButtonClassName}
        onSubmit={async (values) => {
          if (isDisabled) return;
          try {
            await onSubmit({
              email: values.email ?? "",
              password: values.password ?? "",
            });
          } finally {
            setPassword("");
          }
        }}
      />
    </fieldset>
  );
}
