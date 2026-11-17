// Builds the OpenCode configuration that points the agent at RouterAI.
// It is handed to OpenCode inline (OPENCODE_CONFIG_CONTENT), so the plugin
// never edits the user's own OpenCode files.
import type { RouterAiModel } from "./routerai/catalog.js";

/** Provider id inside OpenCode; model ids reach bb as `routerai/<slug>`. */
export const OPENCODE_PROVIDER_ID = "routerai";
export const OPENCODE_CONFIG_ENV = "OPENCODE_CONFIG_CONTENT";

/** The catalog does not publish an output cap; this suits every listed model. */
const MAX_OUTPUT_TOKENS = 32_000;

export function buildOpenCodeConfig(input: {
  baseUrl: string;
  models: readonly RouterAiModel[];
  /**
   * Absolute path of the file holding the API key on the machine that runs
   * the agent. OpenCode reads it itself, so the key never travels in the
   * configuration. Absent while signed out.
   */
  credentialsPath?: string;
}): string {
  const [first] = input.models;
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    // Only RouterAI models reach the picker, not OpenCode's own catalog.
    enabled_providers: [OPENCODE_PROVIDER_ID],
    ...(first === undefined ? {} : { model: `${OPENCODE_PROVIDER_ID}/${first.id}` }),
    provider: {
      [OPENCODE_PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "RouterAI",
        options: {
          baseURL: input.baseUrl,
          ...(input.credentialsPath === undefined
            ? {}
            : { apiKey: `{file:${input.credentialsPath}}` }),
        },
        models: Object.fromEntries(input.models.map((model) => [model.id, openCodeModel(model)])),
      },
    },
  });
}

function openCodeModel(model: RouterAiModel) {
  return {
    name: model.name,
    tool_call: true,
    reasoning: model.reasoning,
    attachment: model.vision,
    modalities: { input: model.vision ? ["text", "image"] : ["text"], output: ["text"] },
    limit: { context: model.contextLength, output: Math.min(MAX_OUTPUT_TOKENS, model.contextLength) },
    // Rubles per million tokens. OpenCode adds up the thread's spend from
    // these and reports it as US dollars whatever the unit; the bridge puts
    // the right currency back (src/spend-currency.ts). Cached tokens cost the
    // plain input price where the catalog lists no price of their own.
    cost: {
      input: model.price.input,
      output: model.price.output,
      cache_read: model.price.cacheRead ?? model.price.input,
      cache_write: model.price.cacheWrite ?? model.price.input,
    },
  };
}
