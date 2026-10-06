"use client";

// Adapted from Towbar and Mill's Apache-2.0 API key settings. See ui/NOTICE.md.
import Copy01Icon from "@hugeicons/core-free-icons/Copy01Icon";
import Key01Icon from "@hugeicons/core-free-icons/Key01Icon";
import PlusSignIcon from "@hugeicons/core-free-icons/PlusSignIcon";
import ShieldBanIcon from "@hugeicons/core-free-icons/ShieldBanIcon";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Chip,
  FieldError,
  Form,
  Input,
  Label,
  Modal,
  Table,
  TextField,
} from "@heroui/react";
import { toast } from "@heroui/react/toast";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Button } from "./ui/button";
import { PageHeading } from "./ui/page-heading";
import { Widget } from "./ui/widget";

type ApiKey = {
  id: string;
  token_hint: string;
  created_at: string;
  expires_at: string;
  status: "active" | "expired" | "revoked";
};
type GeneratedKey = ApiKey & { api_key: string };
type KeyPage = {
  api_keys: ApiKey[];
  total: number;
  limit: number;
  offset: number;
};
const endpoint = "/auth/key-management/api-keys";
const date = (value: string) =>
  new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" });

function SettingsDialog({
  title,
  children,
  footer,
  onClose,
  pending = false,
}: {
  title: string;
  children: ReactNode;
  footer: ReactNode;
  onClose: () => void;
  pending?: boolean;
}) {
  return (
    <Modal.Backdrop
      isOpen
      isDismissable={!pending}
      isKeyboardDismissDisabled={pending}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <Modal.Container size="sm">
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>{title}</Modal.Heading>
            <Modal.CloseTrigger isDisabled={pending} />
          </Modal.Header>
          <Modal.Body>{children}</Modal.Body>
          <Modal.Footer>{footer}</Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function VerifyIdentity({
  onClose,
  onVerified,
}: {
  onClose: () => void;
  onVerified: () => void;
}) {
  const formId = useId();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    const clear = () => setPassword("");
    window.addEventListener("pagehide", clear);
    return () => window.removeEventListener("pagehide", clear);
  }, []);
  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setInvalid(false);
    try {
      const response = await fetch("/auth/key-management/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
        cache: "no-store",
        redirect: "error",
      });
      if (!response.ok) {
        setInvalid(response.status === 401);
        toast.danger(
          response.status === 401
            ? "Invalid credentials"
            : response.status === 429
              ? "Too many attempts. Wait a minute and try again."
              : "Unable to verify your identity. Try again.",
        );
        return;
      }
      const result: { signed_in?: boolean } = await response.json();
      if (!result.signed_in) throw new Error("Identity verification failed");
      onVerified();
    } catch {
      toast.danger("Unable to connect. Try again.");
    } finally {
      setPassword("");
      setPending(false);
    }
  }
  return (
    <SettingsDialog
      title="Verify your identity"
      onClose={onClose}
      pending={pending}
      footer={
        <>
          <Button variant="secondary" isDisabled={pending} onPress={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} isPending={pending}>
            Continue
          </Button>
        </>
      }
    >
      <Form id={formId} onSubmit={verify} className="content-grid">
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
          <Input autoFocus variant="secondary" maxLength={254} />
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
      </Form>
    </SettingsDialog>
  );
}

export function ApiKeySettings() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [pending, setPending] = useState(true);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [generated, setGenerated] = useState<GeneratedKey>();
  const [revoking, setRevoking] = useState<ApiKey | "all">();
  const sequence = useRef(0);
  const revoked = useRef(new Set<string>());
  const secretInput = useRef<HTMLInputElement>(null);
  const load = useCallback(async (offset = 0) => {
    const current = ++sequence.current;
    setPending(true);
    setError("");
    try {
      const response = await fetch(endpoint + `?limit=50&offset=${offset}`, {
        cache: "no-store",
        redirect: "error",
      });
      if (current !== sequence.current) return;
      if (response.status === 401) {
        setLocked(true);
        setKeys([]);
        setNextOffset(null);
        return;
      }
      if (!response.ok) throw new Error("Unable to load API keys. Try again.");
      const page: KeyPage = await response.json();
      if (current !== sequence.current) return;
      setLocked(false);
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
      if (current === sequence.current)
        setError("Unable to load API keys. Try again.");
    } finally {
      if (current === sequence.current) setPending(false);
    }
  }, []);
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, [load]);
  useEffect(() => {
    const clear = () => {
      if (secretInput.current) secretInput.current.value = "";
      setGenerated(undefined);
    };
    window.addEventListener("pagehide", clear);
    return () => window.removeEventListener("pagehide", clear);
  }, []);
  function managementExpired() {
    setGenerated(undefined);
    setCreating(false);
    setRevoking(undefined);
    setLocked(true);
    setKeys([]);
    setNextOffset(null);
    setVerifying(true);
  }
  async function create() {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        cache: "no-store",
        redirect: "error",
      });
      if (response.status === 401) {
        managementExpired();
        return;
      }
      if (!response.ok) throw new Error("Unable to create an API key");
      const result: GeneratedKey = await response.json();
      setGenerated(result);
      setCreating(false);
      void load();
    } catch {
      toast.danger("Unable to create an API key. Try again.");
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    if (!generated) return;
    try {
      await navigator.clipboard.writeText(generated.api_key);
      toast.success("API key copied.");
    } catch {
      secretInput.current?.focus();
      secretInput.current?.select();
      toast.warning("Select the key and copy it manually.");
    }
  }
  async function revoke() {
    if (!revoking || busy) return;
    setBusy(true);
    const target = revoking;
    try {
      const response = await fetch(
        endpoint + (target === "all" ? "" : "/" + target.id),
        { method: "DELETE", cache: "no-store", redirect: "error" },
      );
      if (response.status === 401) {
        managementExpired();
        return;
      }
      if (!response.ok) throw new Error("Unable to revoke the API key");
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
    } catch {
      toast.danger("Unable to revoke API keys. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="min-w-0">
      <PageHeading
        title="API Keys"
        icon={<HugeiconsIcon icon={Key01Icon} />}
        actions={
          <Button
            isDisabled={pending || busy}
            onPress={() => (locked ? setVerifying(true) : setCreating(true))}
          >
            <HugeiconsIcon icon={PlusSignIcon} aria-hidden="true" />
            Create API key
          </Button>
        }
      />
      <section
        aria-label="API keys"
        aria-busy={pending}
        className="content-grid"
      >
        {locked ? (
          <Widget>
            <Widget.Content>
              <div className="content-grid">
                <p className="text-sm text-muted">
                  Verify your identity to manage API keys.
                </p>
                <Button className="w-fit" onPress={() => setVerifying(true)}>
                  Verify identity
                </Button>
              </div>
            </Widget.Content>
          </Widget>
        ) : keys.length ? (
          <>
            <Table>
              <Table.ScrollContainer>
                <Table.Content
                  aria-label="API keys"
                  className="w-full table-fixed"
                >
                  <Table.Header>
                    <Table.Column isRowHeader>Key</Table.Column>
                    <Table.Column className="hidden md:table-cell">
                      Status
                    </Table.Column>
                    <Table.Column className="hidden md:table-cell">
                      Created
                    </Table.Column>
                    <Table.Column className="hidden md:table-cell">
                      Expires
                    </Table.Column>
                    <Table.Column className="w-24">Action</Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {keys.map((key) => (
                      <Table.Row key={key.id} id={key.id}>
                        <Table.Cell>
                          <div className="grid gap-1">
                            <span className="font-mono text-sm">
                              {key.token_hint}
                            </span>
                            <span className="text-xs text-muted md:hidden">
                              {key.status === "active" ? "Active" : "Expired"} ·
                              Expires {date(key.expires_at)}
                            </span>
                          </div>
                        </Table.Cell>
                        <Table.Cell className="hidden md:table-cell">
                          <Chip
                            size="sm"
                            color={
                              key.status === "active" ? "success" : "warning"
                            }
                            variant="soft"
                          >
                            {key.status === "active" ? "Active" : "Expired"}
                          </Chip>
                        </Table.Cell>
                        <Table.Cell className="hidden md:table-cell">
                          <time
                            dateTime={key.created_at}
                            className="text-sm text-muted"
                          >
                            {date(key.created_at)}
                          </time>
                        </Table.Cell>
                        <Table.Cell className="hidden md:table-cell">
                          <time
                            dateTime={key.expires_at}
                            className="text-sm text-muted"
                          >
                            {date(key.expires_at)}
                          </time>
                        </Table.Cell>
                        <Table.Cell>
                          <Button
                            variant="danger"
                            isDisabled={busy}
                            onPress={() => setRevoking(key)}
                          >
                            Revoke
                          </Button>
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table>
            <div className="flex flex-wrap items-center justify-between gap-3">
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
                variant="danger"
                isDisabled={pending || busy}
                onPress={() => setRevoking("all")}
              >
                Revoke all API keys
              </Button>
            </div>
          </>
        ) : !pending && !error ? (
          <div className="grid gap-2 py-12 text-center">
            <h2 className="text-sm font-medium">No API keys yet</h2>
            <p className="text-sm text-muted">
              Create an API key for your scripts or apps.
            </p>
          </div>
        ) : null}
        {error ? (
          <div className="content-grid">
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
            <Button
              variant="secondary"
              className="w-fit"
              onPress={() => void load()}
            >
              Retry loading API keys
            </Button>
          </div>
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
      {creating ? (
        <SettingsDialog
          title="Create API key"
          onClose={() => setCreating(false)}
          pending={busy}
          footer={
            <>
              <Button
                variant="secondary"
                isDisabled={busy}
                onPress={() => setCreating(false)}
              >
                Cancel
              </Button>
              <Button isPending={busy} onPress={create}>
                Create API key
              </Button>
            </>
          }
        >
          <p className="text-sm text-muted">
            Create an API key for your scripts or apps. This key expires in 30
            days.
          </p>
        </SettingsDialog>
      ) : null}
      {generated ? (
        <SettingsDialog
          title="Copy your API key"
          onClose={() => setGenerated(undefined)}
          footer={
            <>
              <Button variant="secondary" onPress={copy}>
                <HugeiconsIcon icon={Copy01Icon} aria-hidden="true" />
                Copy API key
              </Button>
              <Button onPress={() => setGenerated(undefined)}>Done</Button>
            </>
          }
        >
          <div className="content-grid">
            <p className="text-sm text-muted">
              Save this key in your secret storage. It is shown only in this
              dialog and cannot be viewed again after you close it.
            </p>
            <TextField isReadOnly value={generated.api_key} name="api-key">
              <Label>API key</Label>
              <Input
                ref={secretInput}
                className="font-mono"
                variant="secondary"
                autoComplete="off"
                spellCheck={false}
              />
            </TextField>
            <p className="text-sm text-muted">
              Expires{" "}
              <time dateTime={generated.expires_at}>
                {date(generated.expires_at)}
              </time>
            </p>
          </div>
        </SettingsDialog>
      ) : null}
      {revoking ? (
        <SettingsDialog
          title={
            revoking === "all" ? "Revoke all API keys?" : "Revoke API key?"
          }
          onClose={() => setRevoking(undefined)}
          pending={busy}
          footer={
            <>
              <Button
                variant="secondary"
                isDisabled={busy}
                onPress={() => setRevoking(undefined)}
              >
                Cancel
              </Button>
              <Button variant="danger" isPending={busy} onPress={revoke}>
                <HugeiconsIcon icon={ShieldBanIcon} aria-hidden="true" />
                {revoking === "all" ? "Revoke all API keys" : "Revoke API key"}
              </Button>
            </>
          }
        >
          <p className="text-sm text-muted">
            {revoking === "all"
              ? "All API keys and MCP connections will stop working immediately. Your current browser session will stay signed in."
              : "This API key or MCP connection will stop working immediately."}
          </p>
        </SettingsDialog>
      ) : null}
    </section>
  );
}
