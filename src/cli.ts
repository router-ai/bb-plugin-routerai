// `bb routerai …`: the same actions the settings page offers, for agents and
// for work over a terminal.
import type { AccountStatus } from "./account.js";
import { isModelSlug, type RouterAiModel } from "./routerai/catalog.js";

export interface CliActions {
  status(): Promise<{ account: AccountStatus; models: RouterAiModel[]; missing: string[] }>;
  /** Starts a sign-in and returns the address to open. */
  startLogin(manual: boolean): Promise<{ authorizeUrl: string; manual: boolean }>;
  completeLogin(pasted: string): Promise<void>;
  logout(): Promise<void>;
  catalog(): Promise<RouterAiModel[]>;
  setModels(ids: readonly string[]): Promise<void>;
}

interface CliResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export const CLI_COMMANDS = [
  { name: "status", summary: "Sign-in, balance, key limit and picker models", usage: "bb routerai status [--json]" },
  { name: "login", summary: "Sign in with RouterAI", usage: "bb routerai login [--manual] | bb routerai login --code <code-or-url>" },
  { name: "logout", summary: "Forget the RouterAI key", usage: "bb routerai logout" },
  { name: "models", summary: "List, search or set the picker models", usage: "bb routerai models [--json] | models search <text> | models set <slug>… | models reset" },
] as const;

export async function runCli(argv: readonly string[], actions: CliActions): Promise<CliResult> {
  const json = argv.includes("--json");
  const args = argv.filter((arg) => arg !== "--json");
  const [command, ...rest] = args;
  try {
    switch (command) {
      case "status":
        return await status(actions, json);
      case "login":
        return await login(actions, rest);
      case "logout":
        await actions.logout();
        return ok("Signed out of RouterAI.");
      case "models":
        return await models(actions, rest, json);
      default:
        return {
          exitCode: command === undefined || command === "--help" || command === "help" ? 0 : 2,
          stdout: CLI_COMMANDS.map((entry) => `${entry.usage}\n    ${entry.summary}`).join("\n"),
        };
    }
  } catch (error) {
    return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
  }
}

function ok(stdout: string): CliResult {
  return { exitCode: 0, stdout };
}

async function status(actions: CliActions, json: boolean): Promise<CliResult> {
  const result = await actions.status();
  if (json) return ok(JSON.stringify(result, null, 2));
  const lines: string[] = [];
  const { account } = result;
  if (!account.signedIn) {
    lines.push("Not signed in. Run `bb routerai login`.");
  } else if (account.problem !== undefined) {
    lines.push(
      account.problem.kind === "rejected"
        ? `RouterAI rejected the key (${account.problem.message}). Run \`bb routerai login\`.`
        : `RouterAI is unreachable: ${account.problem.message}`,
    );
  } else {
    lines.push(`Balance: ${rub(account.balance)}`);
    if (account.key !== null) {
      const { key } = account;
      lines.push(
        key.limit === null
          ? `Key "${key.name}": no spend limit`
          : `Key "${key.name}": ${rub(key.limitRemaining)} left of ${rub(key.limit)}${key.limitReset === null ? "" : ` (${key.limitReset})`}`,
      );
    }
  }
  lines.push("", "Picker models (the first is the default):", ...result.models.map(modelLine));
  for (const id of result.missing) lines.push(`  ${id} — not in the RouterAI catalog any more`);
  return ok(lines.join("\n"));
}

async function login(actions: CliActions, rest: readonly string[]): Promise<CliResult> {
  const codeAt = rest.indexOf("--code");
  if (codeAt !== -1) {
    const pasted = rest[codeAt + 1];
    if (pasted === undefined) return { exitCode: 2, stderr: "--code needs the code or the callback address" };
    await actions.completeLogin(pasted);
    return ok("Signed in to RouterAI.");
  }
  const started = await actions.startLogin(rest.includes("--manual"));
  return ok(
    started.manual
      ? `Open this address, consent, then run \`bb routerai login --code <code>\` with the code RouterAI shows:\n${started.authorizeUrl}`
      : `Open this address in a browser on the machine that runs the bb server and consent:\n${started.authorizeUrl}\n\nIf the browser cannot reach bb afterwards, copy the address it tried to open and run \`bb routerai login --code <address>\`. On another machine use \`bb routerai login --manual\`.`,
  );
}

async function models(actions: CliActions, rest: readonly string[], json: boolean): Promise<CliResult> {
  const [sub, ...values] = rest;
  if (sub === "set") {
    if (values.length === 0) return { exitCode: 2, stderr: "models set needs at least one <author>/<model> slug" };
    const bad = values.filter((value) => !isModelSlug(value));
    if (bad.length > 0) return { exitCode: 2, stderr: `Not a model slug: ${bad.join(", ")}` };
    const known = new Set((await actions.catalog()).map((model) => model.id));
    const unknown = values.filter((value) => !known.has(value));
    if (unknown.length > 0) {
      return { exitCode: 1, stderr: `Not in the RouterAI catalog (or cannot call tools): ${unknown.join(", ")}` };
    }
    await actions.setModels(values);
    return ok(`Picker models: ${values.join(", ")}`);
  }
  if (sub === "reset") {
    await actions.setModels([]);
    return ok("Picker models reset to the starter set.");
  }
  if (sub === "search") {
    const needle = values.join(" ").toLowerCase();
    const found = (await actions.catalog()).filter(
      (model) => model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle),
    );
    return ok(json ? JSON.stringify(found, null, 2) : found.map(modelLine).join("\n") || "Nothing found.");
  }
  const result = await actions.status();
  return ok(json ? JSON.stringify(result.models, null, 2) : result.models.map(modelLine).join("\n"));
}

function modelLine(model: RouterAiModel): string {
  const context = model.contextLength >= 1_000_000
    ? `${Math.round(model.contextLength / 100_000) / 10}M`
    : `${Math.round(model.contextLength / 1000)}K`;
  return `  ${model.id} — ${model.name} · ${rub(model.price.input)} in / ${rub(model.price.output)} out per 1M tokens · ${context} context`;
}

function rub(value: number | null): string {
  return value === null ? "unknown" : `${Math.round(value * 100) / 100} ₽`;
}
