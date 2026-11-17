// Shared test data: a small RouterAI catalog and a scripted `fetch`.
import type { FetchLike } from "../src/routerai/api.js";

export function catalogEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "deepseek/deepseek-v4-flash",
    name: "DeepSeek: DeepSeek V4 Flash",
    description: "Fast model",
    context_length: 1_048_576,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: { prompt: 0.0000102, completion: 0.0000204, input_cache_read: 0.000001 },
    pricing_units: { prompt: "token", completion: "token", input_cache_read: "token" },
    supported_parameters: ["tools", "reasoning", "temperature"],
    ...overrides,
  };
}

export const CATALOG = [
  catalogEntry(),
  catalogEntry({
    id: "anthropic/claude-sonnet-5.5",
    name: "Anthropic: Claude Sonnet 5.5",
    context_length: 1_000_000,
    architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
    pricing: { prompt: 0.0002145, completion: 0.0010727 },
    pricing_units: { prompt: "token", completion: "token" },
  }),
  catalogEntry({ id: "openai/gpt-5.4-mini", name: "OpenAI: GPT-5.4 Mini", context_length: 400_000 }),
  catalogEntry({ id: "moonshotai/kimi-k2.7-code", name: "MoonshotAI: Kimi K2.7 Code", context_length: 262_144 }),
  catalogEntry({ id: "qwen/qwen3-coder-next", name: "Qwen: Qwen3 Coder Next", context_length: 262_144 }),
];

export interface FetchCall {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

type Route = (call: FetchCall) => { status?: number; json: unknown } | Promise<{ status?: number; json: unknown }>;

/** A `fetch` that answers from a `"<METHOD> <path>"` table and records calls. */
export function scriptedFetch(routes: Record<string, Route>): { fetch: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchLike: FetchLike = async (input, init) => {
    const url = new URL(input);
    const headers = new Headers(init?.headers);
    const call: FetchCall = {
      method: init?.method ?? "GET",
      path: url.pathname.replace(/^\/api\/v1/, ""),
      authorization: headers.get("authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const route = routes[`${call.method} ${call.path}`];
    if (route === undefined) return Response.json({ error: "not found" }, { status: 404 });
    const answer = await route(call);
    return Response.json(answer.json, { status: answer.status ?? 200 });
  };
  return { fetch: fetchLike, calls };
}
