import { describe, expect, it } from "vitest";
import { relabelSpend } from "../src/spend-currency.js";

const usage = (currency: string) =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "thread/deltas",
    params: {
      threadId: "thr_1",
      deltas: [
        { kind: "agentMessage", text: "done" },
        { kind: "contextWindow", used: 10260, size: 1048576, estimated: false, attach: "open", cost: { amount: 1.25, currency } },
      ],
    },
  }) + "\n";

describe("relabelSpend", () => {
  it("turns the agent's dollars into rubles and keeps the amount", () => {
    expect(relabelSpend(usage("USD"))).toBe(usage("RUB"));
  });

  it("leaves other lines exactly as they were", () => {
    const delta = JSON.stringify({ method: "event", params: { text: 'cost {"currency":"USD"}' } }) + "\n";
    expect(relabelSpend(delta)).toBe(delta);
    expect(relabelSpend('not json "contextWindow"\n')).toBe('not json "contextWindow"\n');
  });

  it("does not touch a usage without a spend or with another currency", () => {
    const bare = JSON.stringify({ deltas: [{ kind: "contextWindow", used: 1 }] }) + "\n";
    expect(relabelSpend(bare)).toBe(bare);
    expect(relabelSpend(usage("EUR"))).toBe(usage("EUR"));
  });

  it("does not rewrite text that only mentions a usage", () => {
    const quoted = JSON.stringify({ text: '{"kind":"contextWindow","cost":{"amount":1,"currency":"USD"}}' }) + "\n";
    expect(relabelSpend(quoted)).toBe(quoted);
  });
});
