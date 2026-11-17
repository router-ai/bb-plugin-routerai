import { describe, expect, it } from "vitest";
import { formatContext, formatKeyLimit, formatPrice, formatRub, moveItem, searchCatalog, formatSpend } from "../src/app-format.js";
import type { ModelInfo } from "../src/rpc.js";

function model(id: string, name: string): ModelInfo {
  return { id, name, contextLength: 262_144, price: { input: 12.87, output: 85.82 }, reasoning: false, vision: false };
}

const nbsp = (text: string) => text.replace(/[  ]/g, " ");

describe("formatting", () => {
  it("writes rubles the Russian way", () => {
    expect(nbsp(formatRub(1234.567))).toBe("1 234,57 ₽");
    expect(nbsp(formatRub(800))).toBe("800 ₽");
    expect(formatRub(null)).toBe("—");
  });

  it("shortens context sizes", () => {
    expect(formatContext(262_144)).toBe("262K");
    expect(formatContext(1_048_576)).toBe("1M");
    expect(formatContext(1_050_000)).toBe("1.1M");
  });

  it("describes prices per million tokens", () => {
    expect(nbsp(formatPrice(model("a/b", "B")))).toBe("12,87 ₽ in · 85,82 ₽ out per 1M tokens");
  });

  it("describes the key limit with its period", () => {
    expect(nbsp(formatKeyLimit({ limit: 800, limitRemaining: 799.29, limitReset: "daily" }))).toBe(
      "799,29 ₽ left of 800 ₽ a day",
    );
    expect(nbsp(formatKeyLimit({ limit: 500, limitRemaining: 500, limitReset: null }))).toBe("500 ₽ left of 500 ₽");
    expect(formatKeyLimit({ limit: null, limitRemaining: null, limitReset: null })).toBe("No spend limit");
  });
});

describe("searchCatalog", () => {
  const catalog = [
    model("qwen/qwen3-coder-next", "Qwen: Qwen3 Coder Next"),
    model("qwen/qwen3-coder-flash", "Qwen: Qwen3 Coder Flash"),
    model("openai/gpt-5.4-mini", "OpenAI: GPT-5.4 Mini"),
  ];

  it("matches every typed word against slug and name, any case", () => {
    expect(searchCatalog(catalog, "QWEN flash", []).map((found) => found.id)).toEqual(["qwen/qwen3-coder-flash"]);
    expect(searchCatalog(catalog, "mini", []).map((found) => found.id)).toEqual(["openai/gpt-5.4-mini"]);
  });

  it("leaves out models that are already chosen", () => {
    expect(searchCatalog(catalog, "qwen", ["qwen/qwen3-coder-next"]).map((found) => found.id)).toEqual([
      "qwen/qwen3-coder-flash",
    ]);
  });

  it("returns nothing for an empty query and respects the limit", () => {
    expect(searchCatalog(catalog, "  ", [])).toEqual([]);
    expect(searchCatalog(catalog, "qwen", [], 1)).toHaveLength(1);
  });
});

describe("moveItem", () => {
  it("moves an item one place and ignores moves past the ends", () => {
    expect(moveItem(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
    expect(moveItem(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(moveItem(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
  });
});

describe("formatSpend", () => {
  it("shows kopecks and never rounds a real spend down to nothing", () => {
    expect(formatSpend(0.27534626)).toBe("0,28 ₽");
    expect(formatSpend(1234.5)).toBe("1\u00a0234,50 ₽");
    expect(formatSpend(0.004)).toBe("< 0,01 ₽");
    expect(formatSpend(0)).toBe("0,00 ₽");
  });
});
