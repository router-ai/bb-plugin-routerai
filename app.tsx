// bb-plugin-routerai — frontend entry (loaded by the bb app).
//
// The RouterAI settings page (sign-in, balance, the picker's model list) and
// the balance in the sidebar footer come from the plugin's server part over
// RPC; the API key never reaches the browser. A thread's spend comes from bb
// itself, which records what the agent reports.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  definePluginApp,
  experimental_THREAD_CONTEXT_SEGMENT_GROUPS,
  experimental_ThreadContextCardRow as ThreadContextCardRow,
  useRealtime,
  useRpc,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  formatContext,
  formatKeyLimit,
  formatPrice,
  formatRub,
  formatSpend,
  moveItem,
  searchCatalog,
} from "./src/app-format";
import { SPEND_CURRENCY } from "./src/spend-currency";
import { CHANGED_CHANNEL, type AccountInfo, type ModelInfo, type StatusResult, type rpcContract } from "./src/rpc";

const BILLING_URL = "https://routerai.ru/settings/billing";
const KEYS_URL = "https://routerai.ru/settings/keys";

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The plugin status, re-read whenever the server signals a change. */
function useStatus() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<StatusResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("status", {}).then(
      (result) => {
        setStatus(result);
        setError(null);
      },
      (cause: unknown) => setError(messageOf(cause)),
    );
  }, [rpc]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime(CHANGED_CHANNEL, refetch);
  return { rpc, status, error, refetch };
}

function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("rounded-lg border border-border bg-card p-4", className)}>{children}</div>;
}

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="mt-3 text-sm text-destructive">
      {children}
    </p>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline-offset-4 hover:underline">
      {children}
    </a>
  );
}

// ── Account ────────────────────────────────────────────────────────────────

function SignIn({ rpc }: { rpc: ReturnType<typeof useStatus>["rpc"] }) {
  // null: not started; otherwise which flow is waiting for the user.
  const [waiting, setWaiting] = useState<"callback" | "manual" | null>(null);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async (manual: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const { authorizeUrl } = await rpc.call("startLogin", { manual });
      window.open(authorizeUrl, "_blank", "noopener");
      setWaiting(manual ? "manual" : "callback");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const finish = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pasted.trim() === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      // On success the server signals a change and this form unmounts.
      await rpc.call("completeLogin", { pasted: pasted.trim() });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel>
      <p className="text-sm text-muted-foreground">
        Sign in to run threads on RouterAI models. RouterAI issues a key for bb with a spend limit you choose; nothing
        is typed by hand.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button onClick={() => void start(false)} disabled={busy}>
          Sign in with RouterAI
        </Button>
        <Button variant="ghost" onClick={() => void start(true)} disabled={busy}>
          Sign in with a code
        </Button>
      </div>
      {waiting === null ? null : (
        <form onSubmit={finish} className="mt-4">
          <p className="text-sm text-muted-foreground">
            {waiting === "callback"
              ? "Consent in the browser tab that opened. If it could not return to bb afterwards, paste the address it tried to open:"
              : "Consent in the browser tab that opened, then paste the code RouterAI shows:"}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Input
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              placeholder={waiting === "callback" ? "Address or code" : "Code"}
              aria-label="Code or callback address"
              autoComplete="off"
            />
            <Button type="submit" variant="outline" disabled={busy || pasted.trim() === ""}>
              Finish
            </Button>
          </div>
        </form>
      )}
      {error === null ? null : <ErrorLine>{error}</ErrorLine>}
    </Panel>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-sm font-medium">{children}</div>
    </div>
  );
}

function Account({
  account,
  rpc,
}: {
  account: Extract<AccountInfo, { signedIn: true }>;
  rpc: ReturnType<typeof useStatus>["rpc"];
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signOut = async () => {
    setBusy(true);
    try {
      await rpc.call("logout", {});
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel>
      {account.problem === undefined ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Fact label="Balance">{formatRub(account.balance)}</Fact>
          <Fact label="Key">{account.key?.name ?? "—"}</Fact>
          <Fact label="Key limit">{account.key === null ? "—" : formatKeyLimit(account.key)}</Fact>
        </div>
      ) : (
        <p role="alert" className="text-sm text-destructive">
          {account.problem.kind === "rejected"
            ? "RouterAI rejected the key: it was deleted, disabled or reissued. Sign out and sign in again."
            : `RouterAI could not be reached: ${account.problem.message}`}
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <ExternalLink href={BILLING_URL}>Top up</ExternalLink>
        <ExternalLink href={KEYS_URL}>Change the key limit</ExternalLink>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void signOut()} disabled={busy}>
          Sign out
        </Button>
      </div>
      {error === null ? null : <ErrorLine>{error}</ErrorLine>}
    </Panel>
  );
}

// ── Models ─────────────────────────────────────────────────────────────────

function ModelFacts({ model }: { model: ModelInfo }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="truncate text-sm">{model.name}</div>
      <div className="truncate text-xs text-muted-foreground">
        <span className="font-mono">{model.id}</span> · {formatPrice(model)} · {formatContext(model.contextLength)}{" "}
        context
      </div>
    </div>
  );
}

function Models({ status, rpc }: { status: StatusResult; rpc: ReturnType<typeof useStatus>["rpc"] }) {
  const [catalog, setCatalog] = useState<ModelInfo[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = useMemo(() => status.models.map((model) => model.id), [status.models]);

  useEffect(() => {
    rpc.call("catalog", {}).then(
      (result) => setCatalog(result.models),
      (cause: unknown) => setError(messageOf(cause)),
    );
  }, [rpc]);

  // The server signals after every save, which refreshes `status`.
  const save = async (ids: readonly string[]) => {
    setBusy(true);
    setError(null);
    try {
      await rpc.call("setModels", { ids: [...ids] });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const found = useMemo(() => searchCatalog(catalog ?? [], query, chosen), [catalog, query, chosen]);

  return (
    <div>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {status.models.map((model, index) => (
          <li key={model.id} className="flex items-center gap-2 px-4 py-2.5">
            <ModelFacts model={model} />
            {index === 0 ? (
              <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
                Default
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={`Move ${model.name} up`}
              disabled={busy || index === 0}
              onClick={() => void save(moveItem(chosen, index, -1))}
            >
              <Icon name="ArrowUp" className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={`Move ${model.name} down`}
              disabled={busy || index === chosen.length - 1}
              onClick={() => void save(moveItem(chosen, index, 1))}
            >
              <Icon name="ArrowDown" className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-foreground"
              aria-label={`Remove ${model.name}`}
              // The last model cannot go: an empty list means the starter set.
              disabled={busy || chosen.length === 1}
              onClick={() => void save(chosen.filter((id) => id !== model.id))}
            >
              <Icon name="X" className="size-4" />
            </Button>
          </li>
        ))}
      </ul>

      {status.missing.length === 0 ? null : (
        <p className="mt-2 text-xs text-muted-foreground">
          No longer in the RouterAI catalog and left out: <span className="font-mono">{status.missing.join(", ")}</span>
        </p>
      )}

      <div className="mt-3 flex items-center gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={catalog === null ? "Loading the catalog…" : `Search ${catalog.length} models to add`}
          aria-label="Search the RouterAI catalog"
          disabled={catalog === null}
        />
        {status.usingStarterSet ? null : (
          <Button variant="ghost" size="sm" className="shrink-0" disabled={busy} onClick={() => void save([])}>
            Reset
          </Button>
        )}
      </div>

      {query.trim() === "" ? null : found.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">Nothing found.</p>
      ) : (
        <ul className="mt-2 max-h-80 divide-y divide-border overflow-y-auto rounded-lg border border-border">
          {found.map((model) => (
            <li key={model.id} className="flex items-center gap-2 px-4 py-2">
              <ModelFacts model={model} />
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={busy}
                onClick={() => void save([...chosen, model.id])}
              >
                <Icon name="Plus" className="size-4" />
                Add
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error === null ? null : <ErrorLine>{error}</ErrorLine>}
    </div>
  );
}

// ── Page and sidebar ───────────────────────────────────────────────────────

function AccountSection() {
  const { rpc, status, error } = useStatus();
  if (status === null) {
    return error === null ? <Panel className="text-sm text-muted-foreground">Loading…</Panel> : <ErrorLine>{error}</ErrorLine>;
  }
  return status.account.signedIn ? <Account account={status.account} rpc={rpc} /> : <SignIn rpc={rpc} />;
}

function ModelsSection() {
  const { rpc, status, error } = useStatus();
  if (status === null) {
    return error === null ? <Panel className="text-sm text-muted-foreground">Loading…</Panel> : <ErrorLine>{error}</ErrorLine>;
  }
  return <Models status={status} rpc={rpc} />;
}

function SidebarBalance() {
  const { status, error } = useStatus();
  if (status === null) {
    return <div className="px-3 py-2 text-xs text-muted-foreground">{error ?? "Loading…"}</div>;
  }
  const { account } = status;
  if (!account.signedIn) {
    return <div className="px-3 py-2 text-xs text-muted-foreground">Not signed in to RouterAI.</div>;
  }
  if (account.problem !== undefined) {
    return (
      <div className="px-3 py-2 text-xs text-destructive">
        {account.problem.kind === "rejected" ? "RouterAI rejected the key." : "RouterAI is unreachable."}
      </div>
    );
  }
  return (
    <div className="flex items-baseline justify-between gap-3 px-3 py-2 text-xs">
      <div className="min-w-0">
        <div className="text-sm font-medium">{formatRub(account.balance)}</div>
        <div className="truncate text-muted-foreground">
          {account.key === null ? "RouterAI balance" : formatKeyLimit(account.key)}
        </div>
      </div>
      <ExternalLink href={BILLING_URL}>Top up</ExternalLink>
    </div>
  );
}

/** While a turn streams the thread changes many times a second. */
const SPEND_REFRESH_MS = 1500;

/**
 * What the thread has spent so far, in rubles; null for a thread that has
 * spent nothing through RouterAI. Only our provider reports rubles, so the
 * currency alone tells our threads from everyone else's.
 */
function useThreadSpend(threadId: string): number | null {
  const sdk = useSdk();
  const [spend, setSpend] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      timer = null;
      sdk.threads.context({ threadId }).then(
        (context) => {
          const cost = context.usage?.cost;
          if (live) setSpend(cost?.currency === SPEND_CURRENCY && cost.amount > 0 ? cost.amount : null);
        },
        () => {}, // keep the last known figure
      );
    };
    setSpend(null);
    load();
    const unsubscribe = sdk.subscribe({
      event: "thread:changed",
      threadId,
      callback: () => {
        timer ??= setTimeout(load, SPEND_REFRESH_MS);
      },
    });
    return () => {
      live = false;
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
    };
  }, [sdk, threadId]);
  return spend;
}

const SPEND_HINT = "Spent by this thread through RouterAI, by the agent's token count";

function ThreadSpendSegment({ threadId }: { threadId: string }) {
  const spend = useThreadSpend(threadId);
  if (spend === null) return null;
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-muted-foreground" title={SPEND_HINT}>
      Spent <span className="tabular-nums text-foreground">{formatSpend(spend)}</span>
    </span>
  );
}

function ThreadSpendCardRow({ threadId }: { threadId: string }) {
  const spend = useThreadSpend(threadId);
  if (spend === null) return null;
  return <ThreadContextCardRow label="Spent" trailing={formatSpend(spend)} title={SPEND_HINT} />;
}

export default definePluginApp((app) => {
  app.slots.experimental_threadContextSegment({
    id: "spend",
    title: "RouterAI spend",
    group: experimental_THREAD_CONTEXT_SEGMENT_GROUPS.thread,
    order: 100,
    summary: ThreadSpendSegment,
    useVisible: ({ threadId }) => useThreadSpend(threadId) !== null,
  });
  app.slots.experimental_threadContextCardRow({
    id: "spend",
    group: "9_routerai",
    component: ThreadSpendCardRow,
  });
  app.slots.settingsSection({
    id: "account",
    title: "Account",
    description: "Your RouterAI balance and the key bb spends from.",
    component: AccountSection,
  });
  app.slots.settingsSection({
    id: "models",
    title: "Models in the picker",
    description: "Any RouterAI model that can call tools. The first one is the default for new threads.",
    component: ModelsSection,
  });
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "balance",
    label: "RouterAI balance",
    icon: "routerai/mark",
    component: SidebarBalance,
  });
});
