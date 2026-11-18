// Claude Code through RouterAI.
//
// bb has its own Claude Code provider. RouterAI speaks the Anthropic API, so
// instead of a second agent bridge the plugin points that provider at
// RouterAI: an address, and a private configuration directory whose settings
// tell Claude Code to read the RouterAI key from our key file. The provider
// keeps everything bb built for it (plan mode, questions, rewind).
import type { RouterAiModel } from "./routerai/catalog.js";

/** bb's own provider; the plugin contributes to it and never registers it. */
export const CLAUDE_PROVIDER_ID = "claude-code";

/**
 * Where Claude Code finds the Anthropic API: it appends `/v1/messages` itself,
 * so the RouterAI address goes in without its version segment.
 */
export function anthropicBaseUrl(routerAiBaseUrl: string): string {
  return routerAiBaseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** The environment that routes one Claude Code process through RouterAI. */
export function claudeCodeEnv(input: {
  baseUrl: string;
  configDir: string;
}): { name: string; value: string; reason: string }[] {
  return [
    {
      name: "ANTHROPIC_BASE_URL",
      value: anthropicBaseUrl(input.baseUrl),
      reason: "Run Claude Code through RouterAI",
    },
    {
      name: "CLAUDE_CONFIG_DIR",
      value: input.configDir,
      reason: "Settings that make Claude Code read the RouterAI key from its file on this machine",
    },
    {
      // A new key after a sign-in must not wait out the default five minutes.
      name: "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
      value: "60000",
      reason: "Pick up a new RouterAI key within a minute",
    },
    {
      name: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      value: "1",
      reason: "No update checks or telemetry to Anthropic with a RouterAI key",
    },
  ];
}

/** The four counters bb records for a Claude Code thread. */
export interface TokenTotals {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
}

/** What the spend is computed from, in the order bb recorded it. */
export type SpendEvent = { kind: "model"; model: string } | { kind: "tokens"; total: TokenTotals };

/** `claude-haiku-5-5` and `anthropic/claude-haiku-5.5` name the same model. */
function canonical(id: string): string {
  return id
    .toLowerCase()
    .replace(/^anthropic\//, "")
    .replace(/\[.*\]$/, "")
    .replace(/[._]/g, "-");
}

export function findModel(models: readonly RouterAiModel[], claudeModelId: string): RouterAiModel | null {
  const wanted = canonical(claudeModelId);
  return models.find((model) => canonical(model.id) === wanted) ?? null;
}

/**
 * What a thread spent, in rubles, by catalog prices: each growth of the
 * token totals is priced at the model the thread ran on at that moment.
 * Returns null when nothing was priced: no tokens yet, or a model the
 * catalog does not list. Tokens of an unlisted model are left out, so the
 * sum never claims more than it knows.
 */
export function spendFromEvents(events: readonly SpendEvent[], models: readonly RouterAiModel[]): number | null {
  let model: RouterAiModel | null = null;
  let previous: TokenTotals = { inputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 };
  let rubles = 0;
  let priced = false;
  for (const event of events) {
    if (event.kind === "model") {
      model = findModel(models, event.model);
      continue;
    }
    const grown = growth(event.total, previous);
    previous = event.total;
    if (model === null) continue;
    const { price } = model;
    rubles +=
      (grown.inputTokens * price.input +
        grown.cacheReadInputTokens * (price.cacheRead ?? price.input) +
        grown.cacheWriteInputTokens * (price.cacheWrite ?? price.input) +
        grown.outputTokens * price.output) /
      1_000_000;
    priced = true;
  }
  return priced ? rubles : null;
}

/** `current - previous`; totals that fell (a cleared context) restart the count. */
function growth(current: TokenTotals, previous: TokenTotals): TokenTotals {
  const keys = ["inputTokens", "cacheReadInputTokens", "cacheWriteInputTokens", "outputTokens"] as const;
  const restarted = keys.some((key) => current[key] < previous[key]);
  const result = { ...current };
  if (!restarted) for (const key of keys) result[key] = current[key] - previous[key];
  return result;
}

/** Reads the two event types the spend needs out of raw thread events. */
export function toSpendEvents(rows: readonly { type: string; data: unknown }[]): SpendEvent[] {
  const events: SpendEvent[] = [];
  for (const row of rows) {
    const data = (typeof row.data === "object" && row.data !== null ? row.data : {}) as Record<string, any>;
    if (row.type === "client/turn/requested") {
      const model = data.execution?.model;
      if (typeof model === "string" && model !== "") events.push({ kind: "model", model });
    } else if (row.type === "thread/tokenUsage/updated") {
      const total = data.tokenUsage?.total;
      if (typeof total !== "object" || total === null) continue;
      const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
      // Older rows carry cache reads only as `cachedInputTokens`.
      const write = count(total.cacheWriteInputTokens);
      events.push({
        kind: "tokens",
        total: {
          inputTokens: count(total.inputTokens),
          cacheReadInputTokens:
            total.cacheReadInputTokens === undefined
              ? Math.max(0, count(total.cachedInputTokens) - write)
              : count(total.cacheReadInputTokens),
          cacheWriteInputTokens: write,
          outputTokens: count(total.outputTokens),
        },
      });
    }
  }
  return events;
}
