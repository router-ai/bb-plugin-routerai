import { describe, expect, it } from "vitest";
import { createRouterAiApi } from "../src/routerai/api.js";
import {
  CatalogStore,
  STARTER_MODEL_IDS,
  isModelSlug,
  parseCatalog,
  parseModelList,
  selectPickerModels,
} from "../src/routerai/catalog.js";
import { CATALOG, catalogEntry, scriptedFetch } from "./fixtures.js";

describe("parseCatalog", () => {
  it("converts per-token prices to rubles per million tokens", () => {
    const [model] = parseCatalog([catalogEntry()]);
    expect(model).toMatchObject({
      id: "deepseek/deepseek-v4-flash",
      contextLength: 1_048_576,
      price: { input: 10.2, output: 20.4, cacheRead: 1 },
      reasoning: true,
      vision: false,
    });
  });

  it("marks models that accept images", () => {
    const models = parseCatalog(CATALOG);
    expect(models.find((model) => model.id === "anthropic/claude-sonnet-5.5")?.vision).toBe(true);
  });

  it("drops models an agent cannot run on", () => {
    const models = parseCatalog([
      catalogEntry({ id: "a/no-tools", supported_parameters: ["temperature"] }),
      catalogEntry({ id: "a/image-out", architecture: { input_modalities: ["text"], output_modalities: ["image"] } }),
      catalogEntry({ id: "a/per-image", pricing_units: { prompt: "image", completion: "token" } }),
      catalogEntry({ id: "a/no-context", context_length: 0 }),
      catalogEntry({ id: "not a slug" }),
      "garbage",
      null,
    ]);
    expect(models).toEqual([]);
  });
});

describe("model list setting", () => {
  it("keeps valid slugs once, in order", () => {
    expect(parseModelList('["b/two","a/one","b/two","bad slug",7]')).toEqual(["b/two", "a/one"]);
  });

  it("treats broken JSON as an empty list", () => {
    expect(parseModelList("{")).toEqual([]);
    expect(parseModelList('"a/one"')).toEqual([]);
  });

  it("accepts catalog slug shapes", () => {
    expect(isModelSlug("qwen/qwen3-coder:exacto")).toBe(true);
    expect(isModelSlug("z-ai/glm-4.6")).toBe(true);
    expect(isModelSlug("no-slash")).toBe(false);
  });
});

describe("selectPickerModels", () => {
  const catalog = parseCatalog(CATALOG);

  it("offers the starter set while nothing is chosen", () => {
    const { models, missing } = selectPickerModels(catalog, []);
    expect(models.map((model) => model.id)).toEqual([...STARTER_MODEL_IDS]);
    expect(missing).toEqual([]);
  });

  it("follows the user's order and reports retired slugs", () => {
    const { models, missing } = selectPickerModels(catalog, ["qwen/qwen3-coder-next", "gone/model", "openai/gpt-5.4-mini"]);
    expect(models.map((model) => model.id)).toEqual(["qwen/qwen3-coder-next", "openai/gpt-5.4-mini"]);
    expect(missing).toEqual(["gone/model"]);
  });
});

describe("CatalogStore", () => {
  it("fetches once within the cache window and serves the last copy on failure", async () => {
    let now = 0;
    let fail = false;
    const { fetch, calls } = scriptedFetch({
      "GET /models": () => (fail ? { status: 500, json: { error: "boom" } } : { json: { data: CATALOG } }),
    });
    const store = new CatalogStore(createRouterAiApi({ baseUrl: () => "https://routerai.test/api/v1", fetch }), () => now);

    expect(await store.list()).toHaveLength(5);
    expect(await store.list()).toHaveLength(5);
    expect(calls).toHaveLength(1);

    now = 11 * 60_000;
    fail = true;
    expect(await store.list()).toHaveLength(5);
    expect(calls).toHaveLength(2);
  });

  it("fails when there is nothing to fall back on", async () => {
    const { fetch } = scriptedFetch({ "GET /models": () => ({ status: 500, json: { error: "boom" } }) });
    const store = new CatalogStore(createRouterAiApi({ baseUrl: () => "https://routerai.test/api/v1", fetch }));
    await expect(store.list()).rejects.toThrow("boom");
  });
});
