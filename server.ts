// bb-plugin-routerai — server entry (runs inside the bb server).
//
// Registers the `routerai` provider on the SDK's ACP bridge with OpenCode as
// the agent, owns the sign-in and the API key, and tells OpenCode which
// RouterAI models to offer.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { AccountStore, type AccountStatus } from "./src/account.js";
import { CLI_COMMANDS, runCli, type CliActions } from "./src/cli.js";
import { PROVIDER_ID, hostContract } from "./src/contract.js";
import { OPENCODE_CONFIG_ENV, buildOpenCodeConfig } from "./src/opencode-config.js";
import { ROUTERAI_DEFAULT_BASE_URL, createRouterAiApi, type FetchLike } from "./src/routerai/api.js";
import { CatalogStore, isModelSlug, parseModelList, selectPickerModels, type RouterAiModel } from "./src/routerai/catalog.js";
import { LoginSessions, parsePastedCode } from "./src/routerai/oauth.js";
import { CHANGED_CHANNEL, rpcContract } from "./src/rpc.js";

export { rpcContract } from "./src/rpc.js";

const OAUTH_CALLBACK_PATH = "/oauth/callback";
const PICKER_SNAPSHOT_KEY = "picker-models";

export interface PluginDeps {
  /** Replaced in tests. */
  fetch?: FetchLike;
}

const SIGNED_OUT_MESSAGE =
  "RouterAI is not signed in. Sign in under Settings → Plugins → RouterAI, or run `bb routerai login`.";
const REJECTED_MESSAGE =
  "RouterAI rejected the key. Sign in again under Settings → Plugins → RouterAI, or run `bb routerai login`.";

/** Storage keys naming the machines that hold a key file. */
const KEY_HOST_PREFIX = "key-host:";

export default async function plugin(bb: BbPluginApi, deps: PluginDeps = {}) {
  const settings = bb.settings.define({
    apiKey: {
      type: "string",
      label: "RouterAI API key",
      description: "Filled by “Sign in with RouterAI”. A key from routerai.ru → Settings → API keys also works.",
      secret: true,
    },
    baseUrl: {
      type: "string",
      label: "RouterAI API address",
      description: "Change only for a staging RouterAI.",
      default: ROUTERAI_DEFAULT_BASE_URL,
      experimental_schema: z.string().url(),
    },
    models: {
      type: "string",
      label: "Model list (JSON)",
      description: "Edited with the model list below or `bb routerai models set`. A JSON array of catalog slugs; empty means the starter set.",
      experimental_multiline: true,
      default: "[]",
      experimental_schema: z.string().refine(
        (value) => {
          try {
            return Array.isArray(JSON.parse(value));
          } catch {
            return false;
          }
        },
        { message: "Expected a JSON array of <author>/<model> slugs" },
      ),
    },
  });

  let baseUrl = (await settings.get()).baseUrl;
  const api = createRouterAiApi({ baseUrl: () => baseUrl, ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) });
  const catalog = new CatalogStore(api);
  const account = new AccountStore(api);
  const logins = new LoginSessions();
  const host = bb.hosts.experimental_client({ contract: hostContract });

  // Where the key file is on each machine, which key it holds and whether
  // that machine was told RouterAI rejected it.
  const credentials = new Map<string, { apiKey: string; path: string; rejected: boolean }>();

  async function writeCredentials(
    hostId: string,
    apiKey: string | undefined,
    rejected = false,
  ): Promise<string | undefined> {
    const known = credentials.get(hostId);
    if (apiKey === undefined || apiKey === "") {
      credentials.delete(hostId);
      await host.call("storeCredentials", { apiKey: null }, { hostId });
      await bb.storage.kv.delete(KEY_HOST_PREFIX + hostId);
      return undefined;
    }
    if (known !== undefined && known.apiKey === apiKey && known.rejected === rejected) return known.path;
    const { path } = await host.call("storeCredentials", { apiKey, ...(rejected ? { rejected } : {}) }, { hostId });
    credentials.set(hostId, { apiKey, path, rejected });
    await bb.storage.kv.set(KEY_HOST_PREFIX + hostId, true);
    return path;
  }

  // One write at a time per machine: a later state must not be overtaken by
  // an earlier one still on its way.
  const writes = new Map<string, Promise<unknown>>();

  function syncCredentials(hostId: string, apiKey: string | undefined, rejected = false): Promise<string | undefined> {
    const next = (writes.get(hostId) ?? Promise.resolve())
      .catch(() => {})
      .then(() => writeCredentials(hostId, apiKey, rejected));
    writes.set(hostId, next);
    return next;
  }

  /** Every machine a key file was written to, remembered across restarts. */
  async function keyHosts(): Promise<string[]> {
    const stored = await bb.storage.kv.list(KEY_HOST_PREFIX);
    return [...new Set([...credentials.keys(), ...stored.map((key) => key.slice(KEY_HOST_PREFIX.length))])];
  }

  /** Brings the key file on every such machine in line; failures are logged. */
  async function syncKeyHosts(apiKey: string | undefined, rejected = false): Promise<void> {
    await Promise.all(
      (await keyHosts()).map((hostId) =>
        syncCredentials(hostId, apiKey, rejected).catch((error: unknown) => {
          bb.log.warn(`Could not update the RouterAI key on ${hostId}: ${String(error)}`);
        }),
      ),
    );
  }

  /**
   * The account status; as a side effect the machines holding the key learn
   * whether RouterAI still accepts it, which is what the provider's readiness
   * in the picker is read from. An unreachable RouterAI changes nothing.
   */
  async function accountStatus(apiKey: string | undefined): Promise<AccountStatus> {
    const status = await account.status(apiKey);
    if (status.signedIn && status.problem?.kind !== "unreachable") {
      void syncKeyHosts(apiKey, status.problem?.kind === "rejected");
    }
    return status;
  }

  settings.onChange((next, prev) => {
    // Open settings pages and the sidebar re-read the status.
    bb.realtime.publish(CHANGED_CHANNEL, null);
    if (next.baseUrl !== prev.baseUrl) {
      baseUrl = next.baseUrl;
      catalog.reset();
    }
    if (next.baseUrl !== prev.baseUrl || next.models !== prev.models) {
      void refreshProvider().catch((error: unknown) => {
        bb.log.warn(`Could not update the RouterAI model list: ${String(error)}`);
      });
    }
    if (next.apiKey !== prev.apiKey) {
      account.reset();
      if (next.apiKey === undefined || next.apiKey === "") {
        // Signed out: remove the key from the machines that had it.
        void syncKeyHosts(undefined);
      }
    }
  });

  async function pickerModels() {
    const current = await settings.get();
    return selectPickerModels(await catalog.list(), parseModelList(current.models));
  }

  async function saveKey(apiKey: string): Promise<void> {
    await settings.experimental_set({ apiKey });
  }

  function callbackUrl(): string {
    return `${bb.server.loopbackBaseUrl}/api/v1/plugins/${bb.pluginId}/http${OAUTH_CALLBACK_PATH}`;
  }

  async function completeLogin(pasted: string): Promise<void> {
    const parsed = parsePastedCode(pasted);
    if (parsed === null) throw new Error("That is neither a code nor a callback address.");
    const login = parsed.state === undefined ? logins.takeLatest() : logins.take(parsed.state);
    if (login === null) throw new Error("No sign-in is waiting for this code. Start again.");
    const key = await api.exchangeCode({
      code: parsed.code,
      codeVerifier: login.codeVerifier,
      ...(login.callbackUrl === undefined ? {} : { callbackUrl: login.callbackUrl }),
    });
    await saveKey(key);
  }

  // The picker asks the agent for its models with the launch environment
  // declared here, so the declaration carries the model list and is replaced
  // whenever that list changes. It never carries the key.
  let registration: { dispose(): void } | null = null;
  let declaredConfig: string | null = null;

  function declareProvider(config: string): void {
    if (config === declaredConfig) return;
    registration?.dispose();
    registration = bb.providers.register({
      id: PROVIDER_ID,
      displayName: "RouterAI",
      icon: "./icons/routerai.svg",
      strings: {
        signInHint: "Sign in on the RouterAI page of the plugin settings, or run `bb routerai login`.",
        expiredHint: "RouterAI rejected the key. Sign in again: `bb routerai login`.",
        installUrl: "https://opencode.ai/docs",
        brandPrefix: "RouterAI/",
      },
      experimental_bridgeOptions: {
        acpDialect: "opencode",
        acpLaunchSpec: {
          displayName: "RouterAI",
          command: "opencode",
          args: ["acp"],
          env: { [OPENCODE_CONFIG_ENV]: config },
        },
      },
      models: { scope: "host" },
      maintenance: { health: true, usage: false, installation: false },
      capabilities: {
        supportsServiceTier: false,
        supportsNativeUserQuestion: false,
        supportsManualCompaction: true,
        supportsThreadArchive: false,
        supportsThreadRename: false,
        fork: "tip",
        permissionModes: ["accept-edits", "full"],
        reasoningLevels: ["low", "medium", "high"],
      },
      composerActions: [],
    });
    declaredConfig = config;
  }

  /**
   * The picker models, surviving a RouterAI outage: the last list that was
   * read is kept in storage and used when the catalog cannot be fetched.
   */
  async function resilientPickerModels(): Promise<RouterAiModel[]> {
    try {
      const { models } = await pickerModels();
      await bb.storage.kv.set(PICKER_SNAPSHOT_KEY, models);
      return models;
    } catch (error) {
      bb.log.warn(`RouterAI catalog is unavailable, using the last known models: ${String(error)}`);
      return (await bb.storage.kv.get<RouterAiModel[]>(PICKER_SNAPSHOT_KEY)) ?? [];
    }
  }

  async function refreshProvider(): Promise<void> {
    const models = await resilientPickerModels();
    declareProvider(buildOpenCodeConfig({ baseUrl, models }));
  }

  await refreshProvider();

  // Prices and the catalog itself change; pick that up without a reload.
  bb.background.schedule("refresh-catalog", "*/30 * * * *", async () => {
    catalog.reset();
    await refreshProvider();
  });

  // A thread's agent gets the same configuration plus a pointer to the key
  // file on its machine; it overrides the declared one for session commands.
  bb.providers.experimental_contributeEnv(PROVIDER_ID, async ({ hostId, threadId }) => {
    // Listing models needs no key, and the picker ignores this anyway.
    if (threadId === null) return [];
    const current = await settings.get();
    const [models, credentialsPath] = await Promise.all([
      resilientPickerModels(),
      // A key known to be rejected stays marked so; only a check clears that.
      syncCredentials(hostId, current.apiKey, credentials.get(hostId)?.rejected ?? false),
    ]);
    return [
      {
        name: OPENCODE_CONFIG_ENV,
        value: buildOpenCodeConfig({
          baseUrl: current.baseUrl,
          models,
          ...(credentialsPath === undefined ? {} : { credentialsPath }),
        }),
        reason: "Let the agent read the RouterAI key from its file on this machine",
      },
    ];
  });

  // RouterAI sends the browser here after consent. The `state` it echoes was
  // minted by us and is good once, which is what guards this open route.
  bb.http.route(
    "GET",
    OAUTH_CALLBACK_PATH,
    async (context) => {
      const url = new URL(context.req.url);
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const login = state === null ? null : logins.take(state);
      if (login === null) return page(400, "This sign-in link is not valid any more. Start again in bb.");
      if (code === null) {
        return page(400, url.searchParams.get("error") === "access_denied" ? "Sign-in was cancelled." : "RouterAI sent no code.");
      }
      try {
        const key = await api.exchangeCode({
          code,
          codeVerifier: login.codeVerifier,
          ...(login.callbackUrl === undefined ? {} : { callbackUrl: login.callbackUrl }),
        });
        await saveKey(key);
      } catch (error) {
        bb.log.warn(`RouterAI sign-in failed: ${String(error)}`);
        return page(502, "RouterAI did not issue a key. Start again in bb.");
      }
      return page(200, "Signed in to RouterAI. You can close this tab and return to bb.");
    },
    { auth: "none" },
  );

  // The bridge calls the provider signed out on a machine that has no key
  // file, or a rejected one. Asked about such a machine, deliver the key if
  // there is a working one; that makes the provider ready there.
  bb.providers.experimental_contributeEnvHealth(PROVIDER_ID, async ({ hostId }) => {
    const { apiKey } = await settings.get();
    const status = await accountStatus(apiKey);
    if (!status.signedIn) return null;
    if (status.problem?.kind === "rejected") {
      await syncCredentials(hostId, apiKey, true);
      return null;
    }
    await syncCredentials(hostId, apiKey);
    return { label: "RouterAI", statusMessage: "Signed in to RouterAI." };
  });

  // A failed turn is the moment a revoked key shows itself; look right away
  // rather than when the settings page is next opened.
  bb.events.on("turn.failed", async () => {
    if ((await keyHosts()).length === 0) return;
    account.reset();
    await accountStatus((await settings.get()).apiKey);
  });

  // Stop a message that cannot be answered before a thread fails on it with
  // a bare "401 Unauthorized": say what to do instead. This sits on the path
  // of every message, so it asks RouterAI only to re-check a key it already
  // knows as rejected.
  bb.experimental_hooks.on("message.dispatch", async ({ requestedExecution }) => {
    if (requestedExecution.providerId !== PROVIDER_ID) return { action: "proceed" };
    const { apiKey } = await settings.get();
    if (apiKey === undefined || apiKey === "") return { action: "reject", message: SIGNED_OUT_MESSAGE };
    if (account.knownRejected(apiKey)) {
      account.reset();
      const status = await accountStatus(apiKey);
      if (status.signedIn && status.problem?.kind === "rejected") {
        return { action: "reject", message: REJECTED_MESSAGE };
      }
    }
    return { action: "proceed" };
  });

  const actions: CliActions = {
    async status() {
      const current = await settings.get();
      const [accountNow, picker] = await Promise.all([accountStatus(current.apiKey), pickerModels()]);
      return { account: accountNow, ...picker };
    },
    async startLogin(manual) {
      const login = logins.start(manual ? {} : { callbackUrl: callbackUrl() });
      return { authorizeUrl: login.authorizeUrl, manual };
    },
    completeLogin,
    async logout() {
      await settings.experimental_set({ apiKey: null });
    },
    catalog: () => catalog.list(),
    async setModels(ids) {
      await settings.experimental_set({ models: JSON.stringify(ids) });
    },
  };

  bb.cli.register({
    name: "routerai",
    summary: "RouterAI sign-in, balance and picker models",
    commands: [...CLI_COMMANDS],
    run: (argv) => runCli(argv, actions),
  });

  bb.rpc.register(rpcContract, {
    async status() {
      const current = await settings.get();
      return { ...(await actions.status()), usingStarterSet: parseModelList(current.models).length === 0 };
    },
    async catalog() {
      return { models: await actions.catalog() };
    },
    async setModels({ ids }) {
      const known = new Set((await actions.catalog()).map((model) => model.id));
      const unknown = ids.filter((id) => !isModelSlug(id) || !known.has(id));
      if (unknown.length > 0) throw new Error(`Not in the RouterAI catalog: ${unknown.join(", ")}`);
      await actions.setModels([...new Set(ids)]);
      return {};
    },
    startLogin: ({ manual }) => actions.startLogin(manual),
    async completeLogin({ pasted }) {
      await actions.completeLogin(pasted);
      return {};
    },
    async logout() {
      await actions.logout();
      return {};
    },
  });
}

function page(status: number, message: string): Response {
  const body = `<!doctype html><meta charset="utf-8"><title>RouterAI</title><body style="font:16px system-ui;margin:15vh auto;max-width:28rem;text-align:center"><p>${message}</p></body>`;
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}
