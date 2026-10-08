"use client";

import {
  CreateApiKeyDialog,
  apiKeyPermissionOptions,
  apiKeyExpiryOptions,
  type CreateApiKeyValues,
} from "@avgeek-oss/design-system/patterns/account-settings/create-api-key-dialog";
import { McpConnectionsSettings } from "@avgeek-oss/design-system/patterns/account-settings/mcp-connections-settings";
import { SettingsPageTitle } from "@avgeek-oss/design-system/patterns/settings/page-title";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { ActionConfirmation } from "@avgeek-oss/design-system/patterns/actions/action-confirmation";
import { ConfirmIdentityDialog } from "@avgeek-oss/design-system/patterns/auth/confirm-identity-dialog";
import { ApplicationPage } from "@avgeek-oss/design-system/patterns/pages/page";
import { ResourceTable } from "@avgeek-oss/design-system/patterns/resource-table";
import PlusSignIcon from "@hugeicons/core-free-icons/PlusSignIcon";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CredentialsForm, type Credentials } from "./credentials-form";
import { Button } from "./ui/button";
import { useAccount } from "./account-context";
import { formatDateTime } from "../lib/date-time";
import { apiFetch } from "../lib/browser-api";

type ApiKey = {
  id: string;
  token_hint: string;
  name: string | null;
  access: "read" | "edit" | null;
  includeAdmin: boolean | null;
  oauth_client_id?: string | null;
  oauth_client_name?: string | null;
  oauth_scopes?: string[] | null;
  created_at: string;
  expires_at: string | null;
  status: "active" | "expired" | "revoked";
};
type GeneratedKey = ApiKey & { api_key: string | null };
type KeyPage = {
  api_keys: ApiKey[];
  total: number;
  limit: number;
  offset: number;
};
const endpoint = "/auth/key-management/api-keys";

function VerifyIdentity({
  onClose,
  onVerified,
}: {
  onClose: () => void;
  onVerified: () => void;
}) {
  const [pending, setPending] = useState(false);
  async function verify(credentials: Credentials) {
    setPending(true);
    try {
      const response = await apiFetch("/auth/key-management/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentials),
        cache: "no-store",
        redirect: "error",
      }).catch(() => {
        throw new Error("Unable to connect. Try again.");
      });
      if (!response.ok)
        throw new Error(
          response.status === 401
            ? "Invalid credentials"
            : response.status === 429
              ? "Too many attempts. Wait a minute and try again."
              : "Unable to verify your identity. Try again.",
        );
      const result: { signed_in?: boolean } = await response.json();
      if (!result.signed_in)
        throw new Error("Unable to verify your identity. Try again.");
      onVerified();
    } finally {
      setPending(false);
    }
  }
  return (
    <ConfirmIdentityDialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      method="custom"
      isPending={pending}
    >
      <CredentialsForm
        variant="secondary"
        autoFocus
        isDisabled={pending}
        onSubmit={verify}
        submitLabel="Continue"
      />
    </ConfirmIdentityDialog>
  );
}

export function ApiKeySettings({
  kind = "api-key",
}: {
  kind?: "api-key" | "mcp";
}) {
  const { preferences } = useAccount();
  const date = (value: string) => formatDateTime(value, preferences).date;
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [pending, setPending] = useState(true);
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey | "all">();
  const sequence = useRef(0);
  const revoked = useRef(new Set<string>());
  const load = useCallback(
    async (offset = 0) => {
      const current = ++sequence.current;
      setPending(true);
      setError(false);
      try {
        const response = await apiFetch(
          endpoint + `?limit=50&offset=${offset}&kind=${kind}`,
          {
            cache: "no-store",
            redirect: "error",
          },
        );
        if (current !== sequence.current) return;
        if (response.status === 401) {
          window.location.assign("/login");
          setKeys([]);
          setNextOffset(null);
          return;
        }
        if (!response.ok)
          throw new Error("Unable to load API keys. Try again.");
        const page: KeyPage = await response.json();
        if (current !== sequence.current) return;
        const visible = page.api_keys.filter(
          (key) => key.status !== "revoked" && !revoked.current.has(key.id),
        );
        setKeys((previous) =>
          offset
            ? [
                ...previous,
                ...visible.filter(
                  (key) => !previous.some((existing) => existing.id === key.id),
                ),
              ]
            : visible,
        );
        setNextOffset(
          offset + page.api_keys.length < page.total
            ? offset + page.api_keys.length
            : null,
        );
      } catch {
        if (current === sequence.current) {
          setError(true);
          toast.danger("Unable to load API keys. Try again.");
        }
      } finally {
        if (current === sequence.current) setPending(false);
      }
    },
    [kind],
  );
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, [load]);

  useEffect(() => {
    const clear = () => setCreating(false);
    window.addEventListener("pagehide", clear);
    return () => window.removeEventListener("pagehide", clear);
  }, []);

  function managementExpired() {
    sequence.current++;
    setPending(false);
    setCreating(false);
    setRevoking(undefined);
    setVerifying(true);
  }
  const creationAttempt = useRef<
    { fingerprint: string; requestId: string; body: string } | undefined
  >(undefined);
  async function create(values: CreateApiKeyValues) {
    if (busy) throw new Error("Key creation is already in progress.");
    setBusy(true);
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
      const response = await apiFetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": attempt.requestId,
        },
        body: attempt.body,
        cache: "no-store",
        redirect: "error",
      }).catch(() => {
        throw new Error("Unable to create an API key. Try again.");
      });
      if (response.status === 401) {
        managementExpired();
        throw new Error("Verify your identity to manage API keys.");
      }
      if (!response.ok)
        throw new Error("Unable to create an API key. Try again.");
      const result: GeneratedKey = await response.json();
      void load();
      return { token: result.api_key };
    } finally {
      setBusy(false);
    }
  }
  async function revoke() {
    if (!revoking || busy) return;
    setBusy(true);
    const target = revoking;
    try {
      const response = await apiFetch(
        endpoint + (target === "all" ? `?kind=${kind}` : "/" + target.id),
        { method: "DELETE", cache: "no-store", redirect: "error" },
      ).catch(() => {
        throw new Error("Unable to revoke API keys. Try again.");
      });
      if (response.status === 401) {
        managementExpired();
        throw new Error("Verify your identity to manage API keys.");
      }
      if (!response.ok)
        throw new Error("Unable to revoke API keys. Try again.");
      sequence.current++;
      if (target === "all") keys.forEach((key) => revoked.current.add(key.id));
      else revoked.current.add(target.id);
      setKeys((previous) =>
        target === "all" ? [] : previous.filter((key) => key.id !== target.id),
      );
      setRevoking(undefined);
      toast.success(
        target === "all" ? "API keys revoked." : "API key revoked.",
      );
      void load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <ApplicationPage
      title={kind === "mcp" ? "MCP Connections" : "API Keys"}
      titleContent={
        <SettingsPageTitle
          section={kind === "mcp" ? "mcp-connections" : "api-keys"}
        />
      }
      breadcrumbAncestors={[
        { label: "Account Settings", href: "/settings/profile" },
      ]}
      actions={
        kind === "api-key" ? (
          <Button
            isDisabled={pending || busy}
            onPress={() => setCreating(true)}
          >
            <HugeiconsIcon icon={PlusSignIcon} size={16} aria-hidden="true" />
            Create API key
          </Button>
        ) : undefined
      }
    >
      <section
        aria-label={kind === "mcp" ? "MCP connections" : "API keys"}
        aria-busy={pending}
        className="content-grid"
      >
        {kind === "mcp" && (keys.length || (!pending && !error)) ? (
          <>
            <McpConnectionsSettings
              items={keys.map((key) => ({
                id: key.id,
                name: key.oauth_client_name ?? "MCP client",
                createdAt: key.created_at,
                expiresAt: key.expires_at!,
                permissions:
                  key.oauth_scopes === null || key.oauth_scopes === undefined
                    ? "—"
                    : key.oauth_scopes.includes("health:write")
                      ? "Edit"
                      : "Read-only",
                client: {
                  name: key.oauth_client_name ?? "MCP client",
                  id: key.oauth_client_id ?? undefined,
                },
              }))}
              formatDate={date}
              onRevoke={async (id) => {
                const response = await apiFetch(`${endpoint}/${id}`, {
                  method: "DELETE",
                  cache: "no-store",
                  redirect: "error",
                });
                if (response.status === 401) {
                  managementExpired();
                  throw new Error(
                    "Verify your identity to manage connections.",
                  );
                }
                if (!response.ok)
                  throw new Error("Unable to revoke connection. Try again.");
                revoked.current.add(id);
                setKeys((previous) => previous.filter((key) => key.id !== id));
                toast.success("Connection revoked");
                void load();
              }}
            />
            {nextOffset !== null ? (
              <Button
                variant="secondary"
                isPending={pending}
                onPress={() => void load(nextOffset)}
              >
                Load more connections
              </Button>
            ) : null}
          </>
        ) : (
          <>
            {keys.length || (!pending && !error) ? (
              <ResourceTable
                ariaLabel="API keys"
                items={keys}
                getRowKey={(key) => key.id}
                emptyTitle="No API keys yet"
                emptyDescription="Create an API key for your scripts or apps."
                tableClassName="w-full table-fixed"
                columns={[
                  {
                    key: "key",
                    header: "Key",
                    isRowHeader: true,
                    cell: (key) => (
                      <div className="grid gap-1">
                        <span className="font-mono text-sm">
                          {key.name ?? key.token_hint}
                        </span>
                        <span className="font-mono text-xs text-muted">
                          {key.token_hint}
                        </span>
                        <span className="text-xs text-muted md:hidden">
                          {key.status === "active" ? "Active" : "Expired"} ·
                          {key.includeAdmin
                            ? "Administrative permissions"
                            : key.access === "edit"
                              ? "Edit"
                              : "Read-only"}{" "}
                          ·{" "}
                          {key.expires_at
                            ? `Expires ${key.expires_at ? date(key.expires_at) : "Never"}`
                            : "Never expires"}
                        </span>
                      </div>
                    ),
                  },
                  {
                    key: "permissions",
                    header: "Permissions",
                    className: "hidden md:table-cell",
                    headerClassName: "hidden md:table-cell",
                    cell: (key) =>
                      key.includeAdmin
                        ? "Administrative permissions"
                        : key.access === "edit"
                          ? "Edit"
                          : "Read-only",
                  },
                  {
                    key: "status",
                    header: "Status",
                    className: "hidden md:table-cell",
                    headerClassName: "hidden md:table-cell",
                    cell: (key) => (
                      <Chip
                        size="sm"
                        color={key.status === "active" ? "success" : "warning"}
                        variant="soft"
                      >
                        {key.status === "active" ? "Active" : "Expired"}
                      </Chip>
                    ),
                  },
                  {
                    key: "created",
                    header: "Created",
                    className: "hidden md:table-cell",
                    headerClassName: "hidden md:table-cell",
                    cell: (key) => (
                      <time
                        dateTime={key.created_at}
                        className="text-sm text-muted"
                      >
                        {date(key.created_at)}
                      </time>
                    ),
                  },
                  {
                    key: "expires",
                    header: "Expires",
                    className: "hidden md:table-cell",
                    headerClassName: "hidden md:table-cell",
                    cell: (key) => (
                      <time
                        dateTime={key.expires_at ?? undefined}
                        className="text-sm text-muted"
                      >
                        {key.expires_at ? date(key.expires_at) : "Never"}
                      </time>
                    ),
                  },
                  {
                    key: "action",
                    header: "Action",
                    headerClassName: "w-24 text-end",
                    className: "text-end",
                    cell: (key) => (
                      <Button
                        size="sm"
                        variant="danger-soft"
                        isDisabled={busy}
                        onPress={() => setRevoking(key)}
                      >
                        Revoke
                      </Button>
                    ),
                  },
                ]}
                footer={
                  keys.length ? (
                    <div className="flex w-full flex-wrap items-center justify-between gap-3">
                      <div>
                        {nextOffset !== null ? (
                          <Button
                            variant="secondary"
                            isPending={pending}
                            onPress={() => void load(nextOffset)}
                          >
                            Load more API keys
                          </Button>
                        ) : null}
                      </div>
                      <Button
                        variant="danger-soft"
                        isDisabled={pending || busy}
                        onPress={() => setRevoking("all")}
                      >
                        Revoke all API keys
                      </Button>
                    </div>
                  ) : undefined
                }
              />
            ) : null}
          </>
        )}
        {error ? (
          <Button
            variant="secondary"
            className="w-fit"
            onPress={() => void load()}
          >
            Retry loading API keys
          </Button>
        ) : null}
      </section>
      {verifying ? (
        <VerifyIdentity
          onClose={() => setVerifying(false)}
          onVerified={() => {
            setVerifying(false);
            void load();
          }}
        />
      ) : null}
      <CreateApiKeyDialog
        isOpen={creating}
        onOpenChange={(open) => {
          setCreating(open);
          if (!open) creationAttempt.current = undefined;
        }}
        permissionOptions={apiKeyPermissionOptions}
        expiryOptions={apiKeyExpiryOptions}
        onCreate={create}
      />
      <ActionConfirmation
        isOpen={!!revoking}
        onOpenChange={(open) => {
          if (!open) setRevoking(undefined);
        }}
        title={revoking === "all" ? "Revoke all API keys?" : "Revoke API key?"}
        description={
          revoking === "all"
            ? "All API keys and MCP connections will stop working immediately. Your current browser session will stay signed in."
            : "This API key or MCP connection will stop working immediately."
        }
        confirmLabel={
          revoking === "all" ? "Revoke all API keys" : "Revoke API key"
        }
        onConfirm={revoke}
      />
    </ApplicationPage>
  );
}
