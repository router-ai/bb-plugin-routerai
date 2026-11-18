import { describe, expect, it } from "vitest";
import {
  anthropicBaseUrl,
  claudeCodeEnv,
  findModel,
  spendFromEvents,
  toSpendEvents,
  type TokenTotals,
} from "../src/claude-code.js";
import type { RouterAiModel } from "../src/routerai/catalog.js";

const model = (id: string, price: RouterAiModel["price"]): RouterAiModel => ({
  id,
  name: id,
  description: "",
  contextLength: 1_000_000,
  price,
  reasoning: true,
  vision: true,
});
const HAIKU = model("anthropic/claude-haiku-5.5", { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 });
const SONNET = model("anthropic/claude-sonnet-5.5", { input: 200, output: 1000, cacheRead: 10, cacheWrite: 250 });
const tokens = (inputTokens: number, cacheReadInputTokens: number, cacheWriteInputTokens: number, outputTokens: number) =>
  ({ kind: "tokens", total: { inputTokens, cacheReadInputTokens, cacheWriteInputTokens, outputTokens } as TokenTotals }) as const;

describe("anthropicBaseUrl", () => {
  it("drops the version segment Claude Code adds itself", () => {
    expect(anthropicBaseUrl("https://routerai.ru/api/v1")).toBe("https://routerai.ru/api");
    expect(anthropicBaseUrl("https://routerai.ru/api/v1/")).toBe("https://routerai.ru/api");
    expect(anthropicBaseUrl("https://gateway.example/anthropic")).toBe("https://gateway.example/anthropic");
  });
});

describe("claudeCodeEnv", () => {
  it("points Claude Code at RouterAI and at the plugin's settings, with no key in it", () => {
    const env = claudeCodeEnv({ baseUrl: "https://routerai.ru/api/v1", configDir: "/host/data/claude-code" });
    const byName = Object.fromEntries(env.map((entry) => [entry.name, entry.value]));
    expect(byName.ANTHROPIC_BASE_URL).toBe("https://routerai.ru/api");
    expect(byName.CLAUDE_CONFIG_DIR).toBe("/host/data/claude-code");
    expect(Object.keys(byName)).not.toContain("ANTHROPIC_AUTH_TOKEN");
    expect(Object.keys(byName)).not.toContain("ANTHROPIC_API_KEY");
  });
});

describe("findModel", () => {
  it("matches bb's Claude Code model ids to catalog slugs", () => {
    expect(findModel([HAIKU, SONNET], "claude-haiku-5-5")).toBe(HAIKU);
    expect(findModel([HAIKU, SONNET], "claude-sonnet-5-5[1m]")).toBe(SONNET);
    expect(findModel([HAIKU, SONNET], "claude-opus-9")).toBeNull();
  });
});

describe("spendFromEvents", () => {
  it("prices each kind of token at its own catalog price", () => {
    const spend = spendFromEvents([{ kind: "model", model: "claude-haiku-5-5" }, tokens(1_000_000, 2_000_000, 400_000, 100_000)], [HAIKU]);
    // 10 + 2 × 1 + 0.4 × 12.5 + 0.1 × 50
    expect(spend).toBeCloseTo(22);
  });

  it("charges only what a later turn added, at the model of that turn", () => {
    const spend = spendFromEvents(
      [
        { kind: "model", model: "claude-haiku-5-5" },
        tokens(1_000_000, 0, 0, 0),
        { kind: "model", model: "claude-sonnet-5-5" },
        tokens(1_500_000, 0, 0, 0),
      ],
      [HAIKU, SONNET],
    );
    expect(spend).toBeCloseTo(10 + 0.5 * 200);
  });

  it("starts counting again when the totals fall, as after a cleared context", () => {
    const spend = spendFromEvents(
      [{ kind: "model", model: "claude-haiku-5-5" }, tokens(1_000_000, 0, 0, 0), tokens(200_000, 0, 0, 0)],
      [HAIKU],
    );
    expect(spend).toBeCloseTo(10 + 2);
  });

  it("is unknown without tokens or for a model the catalog does not list", () => {
    expect(spendFromEvents([{ kind: "model", model: "claude-haiku-5-5" }], [HAIKU])).toBeNull();
    expect(spendFromEvents([{ kind: "model", model: "claude-opus-9" }, tokens(1_000_000, 0, 0, 0)], [HAIKU])).toBeNull();
  });

  it("falls back to the input price where the catalog has no cache prices", () => {
    const plain = model("anthropic/claude-haiku-5.5", { input: 10, output: 50 });
    expect(spendFromEvents([{ kind: "model", model: "claude-haiku-5-5" }, tokens(0, 1_000_000, 1_000_000, 0)], [plain])).toBeCloseTo(20);
  });
});

describe("toSpendEvents", () => {
  it("reads the model of a turn and the token totals from thread events", () => {
    const events = toSpendEvents([
      { type: "client/turn/requested", data: { execution: { model: "claude-haiku-5-5" } } },
      { type: "turn/started", data: {} },
      {
        type: "thread/tokenUsage/updated",
        data: {
          tokenUsage: {
            total: { inputTokens: 12018, cachedInputTokens: 31303, cacheReadInputTokens: 4545, cacheWriteInputTokens: 26758, outputTokens: 84 },
          },
        },
      },
    ]);
    expect(events).toEqual([
      { kind: "model", model: "claude-haiku-5-5" },
      { kind: "tokens", total: { inputTokens: 12018, cacheReadInputTokens: 4545, cacheWriteInputTokens: 26758, outputTokens: 84 } },
    ]);
  });

  it("derives cache reads when only the combined cached count is recorded", () => {
    const [event] = toSpendEvents([
      { type: "thread/tokenUsage/updated", data: { tokenUsage: { total: { inputTokens: 1, cachedInputTokens: 30, cacheWriteInputTokens: 10, outputTokens: 2 } } } },
    ]);
    expect(event).toEqual({ kind: "tokens", total: { inputTokens: 1, cacheReadInputTokens: 20, cacheWriteInputTokens: 10, outputTokens: 2 } });
  });
});
