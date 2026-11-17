import { describe, expect, it } from "vitest";
import { buildOpenCodeConfig } from "../src/opencode-config.js";
import { parseCatalog } from "../src/routerai/catalog.js";
import { CATALOG } from "./fixtures.js";

const models = parseCatalog(CATALOG).slice(0, 2);

describe("buildOpenCodeConfig", () => {
  it("offers only RouterAI models, the first as the default", () => {
    const config = JSON.parse(buildOpenCodeConfig({ baseUrl: "https://routerai.ru/api/v1", models }));
    expect(config.enabled_providers).toEqual(["routerai"]);
    expect(config.model).toBe("routerai/deepseek/deepseek-v4-flash");
    expect(Object.keys(config.provider.routerai.models)).toEqual([
      "deepseek/deepseek-v4-flash",
      "anthropic/claude-sonnet-5.5",
    ]);
    expect(config.provider.routerai.options.baseURL).toBe("https://routerai.ru/api/v1");
  });

  it("passes context size, abilities and ruble prices for each model", () => {
    const config = JSON.parse(buildOpenCodeConfig({ baseUrl: "https://routerai.ru/api/v1", models }));
    expect(config.provider.routerai.models["deepseek/deepseek-v4-flash"]).toEqual({
      name: "DeepSeek: DeepSeek V4 Flash",
      tool_call: true,
      reasoning: true,
      attachment: false,
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 1_048_576, output: 32_000 },
      cost: { input: 10.2, output: 20.4, cache_read: 1, cache_write: 10.2 },
    });
    expect(config.provider.routerai.models["anthropic/claude-sonnet-5.5"].modalities.input).toEqual(["text", "image"]);
  });

  it("points at the key file and never contains a key", () => {
    const signedOut = buildOpenCodeConfig({ baseUrl: "https://routerai.ru/api/v1", models });
    expect(JSON.parse(signedOut).provider.routerai.options.apiKey).toBeUndefined();

    const signedIn = buildOpenCodeConfig({
      baseUrl: "https://routerai.ru/api/v1",
      models,
      credentialsPath: "/data/plugins/routerai/host-data/credentials",
    });
    expect(JSON.parse(signedIn).provider.routerai.options.apiKey).toBe(
      "{file:/data/plugins/routerai/host-data/credentials}",
    );
  });

  it("is stable for the same input, so an unchanged list does not re-register the provider", () => {
    const input = { baseUrl: "https://routerai.ru/api/v1", models };
    expect(buildOpenCodeConfig(input)).toBe(buildOpenCodeConfig(input));
  });
});
