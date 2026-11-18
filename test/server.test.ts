import { createFakePluginHost, makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../server.js";
import { CATALOG, scriptedFetch } from "./fixtures.js";

const HOST = "host-test";
const KEY_FILE = "/host/data/credentials";
const CALLBACK = "http://127.0.0.1:38886/api/v1/plugins/routerai/http/oauth/callback";

interface HostCall {
  method: string;
  input: unknown;
  hostId: string;
}

async function setup(
  options: { settings?: Record<string, string>; catalogFails?: boolean; agentMissing?: boolean } = {},
) {
  const hostCalls: HostCall[] = [];
  const agentChecks = { count: 0 };
  const api = scriptedFetch({
    "GET /models": () =>
      options.catalogFails === true ? { status: 503, json: { error: "down" } } : { json: { data: CATALOG } },
    "GET /credits": (call) =>
      call.authorization === "Bearer sk-good" || call.authorization === "Bearer sk-issued"
        ? { json: { data: { credits: 222.5 } } }
        : { status: 401, json: { error: "401 Unauthorized" } },
    "GET /key": () => ({
      json: { data: { name: "bb", usage: 1, limit: 1000, limit_remaining: 999, limit_reset: "daily", disabled: false } },
    }),
    "POST /auth/keys": (call) => {
      const body = call.body as { code: string };
      return body.code === "good-code"
        ? { json: { key: "sk-issued" } }
        : { status: 400, json: { error: "invalid_grant", error_description: "Code expired" } };
    },
  });
  const { bb, harness } = createFakePluginHost({
    pluginId: "routerai",
    loopbackBaseUrl: "http://127.0.0.1:38886",
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    experimental_hostEntry: true,
    experimental_callHostRpc: async ({ method, input, hostId }) => {
      if (method === "agentInstalled") {
        agentChecks.count += 1;
        return { installed: options.agentMissing !== true };
      }
      hostCalls.push({ method, input, hostId });
      return { path: KEY_FILE };
    },
  });
  await plugin(bb, { fetch: api.fetch, hostname: () => "test-box" });
  /** Loads the plugin again over the same settings and storage, as a restart does. */
  const restart = () => harness.lifecycle.reload((next) => plugin(next, { fetch: api.fetch, hostname: () => "test-box" }));
  return { harness, hostCalls, agentChecks, apiCalls: api.calls, restart };
}

function declaredConfig(harness: Awaited<ReturnType<typeof setup>>["harness"]) {
  const registrations = harness.registrations.providerRegistrations;
  expect(registrations).toHaveLength(1);
  const options = registrations[0]?.experimental_bridgeOptions as {
    acpDialect: string;
    acpLaunchSpec: { command: string; args: string[]; env: Record<string, string> };
  };
  return { options, config: JSON.parse(options.acpLaunchSpec.env.OPENCODE_CONFIG_CONTENT ?? "{}") };
}

function modelIds(config: { provider: { routerai: { models: Record<string, unknown> } } }): string[] {
  return Object.keys(config.provider.routerai.models);
}

let active: Awaited<ReturnType<typeof setup>> | null = null;
afterEach(async () => {
  await active?.harness.lifecycle.dispose();
  active = null;
});

describe("provider declaration", () => {
  it("registers RouterAI on OpenCode with the starter models and no key", async () => {
    active = await setup({ settings: { apiKey: "sk-good" } });
    const { options, config } = declaredConfig(active.harness);
    expect(options.acpDialect).toBe("opencode");
    expect(options.acpLaunchSpec).toMatchObject({ command: "opencode", args: ["acp"] });
    expect(modelIds(config)).toEqual([
      "deepseek/deepseek-v4-flash",
      "anthropic/claude-sonnet-5.5",
      "openai/gpt-5.4-mini",
      "moonshotai/kimi-k2.7-code",
    ]);
    expect(JSON.stringify(options)).not.toContain("sk-good");
    expect(config.provider.routerai.options.apiKey).toBeUndefined();
  });

  it("re-registers when the model list setting changes", async () => {
    active = await setup();
    await active.harness.behavior.setSettings({ models: '["qwen/qwen3-coder-next","openai/gpt-5.4-mini"]' });
    await expect.poll(() => modelIds(declaredConfig(active!.harness).config)).toEqual([
      "qwen/qwen3-coder-next",
      "openai/gpt-5.4-mini",
    ]);
  });

  it("still registers with the last known models when the catalog is down", async () => {
    active = await setup({ catalogFails: true });
    const { config } = declaredConfig(active.harness);
    expect(modelIds(config)).toEqual([]);
  });
});

describe("agent environment", () => {
  it("stores the key on the thread's machine and points OpenCode at the file", async () => {
    active = await setup({ settings: { apiKey: "sk-good" } });
    const env = await active.harness.behavior.resolveProviderEnv("routerai", {
      threadId: "thr_1",
      projectId: "proj_1",
      hostId: HOST,
    });
    expect(active.hostCalls).toEqual([{ method: "storeCredentials", input: { apiKey: "sk-good" }, hostId: HOST }]);
    expect(env).toHaveLength(1);
    expect(env[0]?.name).toBe("OPENCODE_CONFIG_CONTENT");
    const value = env[0]?.value as string;
    expect(JSON.parse(value).provider.routerai.options.apiKey).toBe(`{file:${KEY_FILE}}`);
    // The environment is shown in the thread timeline: the key must not be in it.
    expect(value).not.toContain("sk-good");

    // The same key is not written again on the next command.
    await active.harness.behavior.resolveProviderEnv("routerai", { threadId: "thr_1", projectId: "proj_1", hostId: HOST });
    expect(active.hostCalls).toHaveLength(1);
  });

  it("contributes nothing to model listing, which has no thread", async () => {
    active = await setup({ settings: { apiKey: "sk-good" } });
    const env = await active.harness.behavior.resolveProviderEnv("routerai", {
      threadId: null,
      projectId: null,
      hostId: HOST,
    });
    expect(env).toEqual([]);
    expect(active.hostCalls).toEqual([]);
  });

  it("removes the key file from machines after sign-out", async () => {
    active = await setup({ settings: { apiKey: "sk-good" } });
    await active.harness.behavior.resolveProviderEnv("routerai", { threadId: "thr_1", projectId: "proj_1", hostId: HOST });
    await active.harness.behavior.runCli(["logout"]);
    await expect.poll(() => active!.hostCalls.at(-1)).toEqual({
      method: "storeCredentials",
      input: { apiKey: null },
      hostId: HOST,
    });
  });
});

describe("provider readiness", () => {
  const readiness = () => active!.harness.behavior.resolveProviderEnvHealth("routerai", { hostId: HOST });

  it("stays signed out without a key", async () => {
    active = await setup();
    expect(await readiness()).toBeNull();
    expect(active.hostCalls).toEqual([]);
  });

  it("delivers a working key to a machine that lacks it and calls the provider ready", async () => {
    active = await setup({ settings: { apiKey: "sk-good" } });
    expect(await readiness()).toEqual({ label: "RouterAI", statusMessage: "Signed in to RouterAI." });
    expect(active.hostCalls).toEqual([{ method: "storeCredentials", input: { apiKey: "sk-good" }, hostId: HOST }]);
  });

  it("marks a rejected key on the machine and leaves the provider needing sign-in", async () => {
    active = await setup({ settings: { apiKey: "sk-revoked" } });
    expect(await readiness()).toBeNull();
    expect(active.hostCalls).toEqual([
      { method: "storeCredentials", input: { apiKey: "sk-revoked", rejected: true }, hostId: HOST },
    ]);
  });

  it("tells machines that hold the key when a failed turn reveals it was revoked", async () => {
    active = await setup({ settings: { apiKey: "sk-revoked" } });
    await active.harness.behavior.resolveProviderEnv("routerai", { threadId: "thr_1", projectId: "proj_1", hostId: HOST });
    expect(active.hostCalls).toHaveLength(1);
    await active.harness.behavior.emitThreadEvent("turn.failed", {
      threadId: "thr_1",
      requestId: "req_1",
      turnId: null,
      errorInfo: null,
      inputAccepted: false,
    } as never);
    await expect.poll(() => active!.hostCalls.at(-1)).toEqual({
      method: "storeCredentials",
      input: { apiKey: "sk-revoked", rejected: true },
      hostId: HOST,
    });
    // The next thread command does not quietly clear the mark.
    await active.harness.behavior.resolveProviderEnv("routerai", { threadId: "thr_1", projectId: "proj_1", hostId: HOST });
    expect(active.hostCalls).toHaveLength(2);
  });
});

describe("sending a message", () => {
  function dispatch(providerId = "routerai") {
    const hook = active!.harness.registrations.hooks["message.dispatch"];
    expect(hook).not.toBeNull();
    return hook!(makeMessageDispatchHookContext({ requestedExecution: { providerId } }));
  }

  it("is refused with directions while signed out", async () => {
    active = await setup();
    expect(await dispatch()).toEqual({
      action: "reject",
      message: "RouterAI is not signed in. Sign in under Settings → Plugins → RouterAI, or run `bb routerai login`.",
    });
  });

  it("goes through with a key, without asking RouterAI first", async () => {
    active = await setup({ settings: { apiKey: "sk-good" } });
    const before = active.apiCalls.length;
    expect(await dispatch()).toEqual({ action: "proceed" });
    expect(active.apiCalls).toHaveLength(before);
  });

  it("is refused once the key is known to be rejected", async () => {
    active = await setup({ settings: { apiKey: "sk-revoked" } });
    // Not known yet: the first message goes out and fails at RouterAI.
    expect(await dispatch()).toEqual({ action: "proceed" });
    await active.harness.behavior.runCli(["status"]);
    expect(await dispatch()).toEqual({
      action: "reject",
      message: "RouterAI rejected the key. Sign in again under Settings → Plugins → RouterAI, or run `bb routerai login`.",
    });
  });

  it("is refused with install directions on a machine without OpenCode, asking again each time", async () => {
    active = await setup({ settings: { apiKey: "sk-good" }, agentMissing: true });
    const onMachine = () =>
      active!.harness.registrations.hooks["message.dispatch"]!(
        makeMessageDispatchHookContext({ requestedExecution: { providerId: "routerai" }, host: { id: HOST } }),
      );
    const decision = await onMachine();
    expect(decision.action).toBe("reject");
    expect(decision).toMatchObject({ message: expect.stringContaining("npm install -g opencode-ai") });
    await onMachine();
    expect(active.agentChecks.count).toBe(2);
  });

  it("checks a machine for OpenCode only until it is found there", async () => {
    active = await setup({ settings: { apiKey: "sk-good" } });
    const onMachine = () =>
      active!.harness.registrations.hooks["message.dispatch"]!(
        makeMessageDispatchHookContext({ requestedExecution: { providerId: "routerai" }, host: { id: HOST } }),
      );
    expect(await onMachine()).toEqual({ action: "proceed" });
    expect(await onMachine()).toEqual({ action: "proceed" });
    expect(active.agentChecks.count).toBe(1);
  });

  it("leaves other providers' messages alone", async () => {
    active = await setup();
    expect(await dispatch("claude-code")).toEqual({ action: "proceed" });
  });
});

describe("the name an installation signs in under", () => {
  const appName = (stdout: string) => new URL(stdout.match(/https:\/\/routerai\.ru\/auth\S+/)![0]).searchParams.get("app_name");

  it("carries the machine name and stays the same across sign-ins and restarts", async () => {
    active = await setup();
    const first = appName((await active.harness.behavior.runCli(["login"])).stdout);
    expect(first).toMatch(/^bb-test-box-[0-9a-f]{4}$/);
    expect(appName((await active.harness.behavior.runCli(["login", "--manual"])).stdout)).toBe(first);
    active.harness = (await active.restart()).harness;
    expect(appName((await active.harness.behavior.runCli(["login"])).stdout)).toBe(first);
  });
});

describe("account status", () => {
  it("asks RouterAI once for callers that arrive together", async () => {
    active = await setup({ settings: { apiKey: "sk-good" } });
    const before = active.apiCalls.filter((call) => call.path === "/credits").length;
    await Promise.all([
      active.harness.behavior.runCli(["status"]),
      active.harness.behavior.runCli(["status"]),
      active.harness.behavior.runCli(["status"]),
    ]);
    expect(active.apiCalls.filter((call) => call.path === "/credits").length - before).toBe(1);
  });
});

describe("key files across restarts", () => {
  it("removes the key on sign-out from a machine that got it before the plugin restarted", async () => {
    active = await setup({ settings: { apiKey: "sk-good" } });
    await active.harness.behavior.resolveProviderEnv("routerai", { threadId: "thr_1", projectId: "proj_1", hostId: HOST });
    const restarted = await active.restart();
    active.harness = restarted.harness;
    await active.harness.behavior.runCli(["logout"]);
    await expect.poll(() => active!.hostCalls.at(-1)).toEqual({
      method: "storeCredentials",
      input: { apiKey: null },
      hostId: HOST,
    });
    // Forgotten once removed: a second sign-out has nothing left to clean.
    await active.harness.behavior.runCli(["logout"]);
    expect(active.hostCalls).toHaveLength(2);
  });
});

describe("bb routerai", () => {
  it("reports balance, key limit and picker models", async () => {
    active = await setup({ settings: { apiKey: "sk-good" } });
    const result = await active.harness.behavior.runCli(["status"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Balance: 222.5 ₽");
    expect(result.stdout).toContain('Key "bb": 999 ₽ left of 1000 ₽ (daily)');
    expect(result.stdout).toContain("deepseek/deepseek-v4-flash");
  });

  it("says so when signed out or when the key is rejected", async () => {
    active = await setup();
    expect((await active.harness.behavior.runCli(["status"])).stdout).toContain("Not signed in");

    await active.harness.behavior.setSettings({ apiKey: "sk-revoked" });
    expect((await active.harness.behavior.runCli(["status"])).stdout).toContain("RouterAI rejected the key");
  });

  it("refuses models the catalog does not have", async () => {
    active = await setup();
    const result = await active.harness.behavior.runCli(["models", "set", "gone/model"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("gone/model");
  });

  it("never prints the key", async () => {
    active = await setup({ settings: { apiKey: "sk-good" } });
    const result = await active.harness.behavior.runCli(["status", "--json"]);
    expect(result.stdout).not.toContain("sk-good");
  });
});

describe("sign-in", () => {
  async function startLogin(harness: Awaited<ReturnType<typeof setup>>["harness"], manual = false) {
    const result = await harness.behavior.runCli(manual ? ["login", "--manual"] : ["login"]);
    const url = new URL(/https:\/\/routerai\.ru\/auth\S+/.exec(result.stdout ?? "")![0]);
    return url.searchParams;
  }

  it("trades the callback code for a key and stores it", async () => {
    active = await setup();
    const params = await startLogin(active.harness);
    expect(params.get("callback_url")).toBe(CALLBACK);

    const response = await active.harness.behavior.fetchHttp(
      "GET",
      `/oauth/callback?code=good-code&state=${params.get("state")}`,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Signed in to RouterAI");

    const exchange = active.apiCalls.find((call) => call.path === "/auth/keys");
    expect(exchange?.body).toMatchObject({ code: "good-code", callback_url: CALLBACK, code_challenge_method: "S256" });
    expect((await active.harness.behavior.runCli(["status"])).stdout).toContain("Balance: 222.5 ₽");
  });

  it("rejects a callback with an unknown or reused state", async () => {
    active = await setup();
    const params = await startLogin(active.harness);
    const forged = await active.harness.behavior.fetchHttp("GET", "/oauth/callback?code=good-code&state=forged");
    expect(forged.status).toBe(400);

    const path = `/oauth/callback?code=good-code&state=${params.get("state")}`;
    expect((await active.harness.behavior.fetchHttp("GET", path)).status).toBe(200);
    expect((await active.harness.behavior.fetchHttp("GET", path)).status).toBe(400);
    expect(active.apiCalls.filter((call) => call.path === "/auth/keys")).toHaveLength(1);
  });

  it("stays signed out when RouterAI refuses the code", async () => {
    active = await setup();
    const params = await startLogin(active.harness);
    const response = await active.harness.behavior.fetchHttp(
      "GET",
      `/oauth/callback?code=stale&state=${params.get("state")}`,
    );
    expect(response.status).toBe(502);
    expect((await active.harness.behavior.runCli(["status"])).stdout).toContain("Not signed in");
  });

  it("accepts a pasted code in the manual flow, without a callback address", async () => {
    active = await setup();
    const params = await startLogin(active.harness, true);
    expect(params.has("callback_url")).toBe(false);

    const result = await active.harness.behavior.runCli(["login", "--code", "good-code"]);
    expect(result.exitCode).toBe(0);
    const exchange = active.apiCalls.find((call) => call.path === "/auth/keys");
    expect(exchange?.body).not.toHaveProperty("callback_url");
  });

  it("reports RouterAI's reason when a pasted code is refused", async () => {
    active = await setup();
    await startLogin(active.harness, true);
    const result = await active.harness.behavior.runCli(["login", "--code", "stale"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Code expired");
  });
});
