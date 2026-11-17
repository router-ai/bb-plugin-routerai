// Thin HTTP client for the RouterAI API. Every network call of the plugin's
// server part goes through here, so tests swap `fetch` in one place.

export const ROUTERAI_SITE_URL = "https://routerai.ru";
export const ROUTERAI_DEFAULT_BASE_URL = `${ROUTERAI_SITE_URL}/api/v1`;

const REQUEST_TIMEOUT_MS = 15_000;

export class RouterAiApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Machine-readable `error` field of the response, when RouterAI sent one. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "RouterAiApiError";
  }

  /** The key was rejected: missing, revoked or rotated. */
  get unauthorized(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface RouterAiCredits {
  /** Account balance, rubles. */
  credits: number;
}

export interface RouterAiKeyInfo {
  name: string;
  /** Spent within the current limit period, rubles. */
  usage: number;
  /** Spend limit, rubles; `null` when the key has none. */
  limit: number | null;
  limitRemaining: number | null;
  /** `daily`, `weekly`, `monthly`; `null` when the limit never resets. */
  limitReset: string | null;
  disabled: boolean;
}

export interface RouterAiApi {
  /** Raw catalog entries; the caller validates their shape. */
  listModels(signal?: AbortSignal): Promise<unknown[]>;
  credits(apiKey: string, signal?: AbortSignal): Promise<RouterAiCredits>;
  keyInfo(apiKey: string, signal?: AbortSignal): Promise<RouterAiKeyInfo>;
  /** Trade an OAuth code for an API key. */
  exchangeCode(
    input: { code: string; codeVerifier: string; callbackUrl?: string },
    signal?: AbortSignal,
  ): Promise<string>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function createRouterAiApi(options: {
  baseUrl: () => string;
  fetch?: FetchLike;
}): RouterAiApi {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));

  async function request(
    path: string,
    init: { method?: string; apiKey?: string; body?: unknown; signal?: AbortSignal },
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = init.signal === undefined ? timeout : AbortSignal.any([init.signal, timeout]);
    const response = await doFetch(`${trimSlash(options.baseUrl())}${path}`, {
      method: init.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(init.apiKey === undefined ? {} : { authorization: `Bearer ${init.apiKey}` }),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal,
    });
    const text = await response.text();
    let json: unknown;
    try {
      json = text === "" ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    if (!response.ok) {
      throw new RouterAiApiError(
        errorMessage(json) ?? `RouterAI answered ${response.status}`,
        response.status,
        errorCode(json),
      );
    }
    return json;
  }

  return {
    async listModels(signal) {
      const json = await request("/models", { signal });
      const data = field(json, "data");
      if (!Array.isArray(data)) throw new RouterAiApiError("RouterAI catalog has no model list", 502);
      return data;
    },
    async credits(apiKey, signal) {
      const data = field(await request("/credits", { apiKey, signal }), "data");
      const credits = field(data, "credits");
      if (typeof credits !== "number") throw new RouterAiApiError("RouterAI sent no balance", 502);
      return { credits };
    },
    async keyInfo(apiKey, signal) {
      const data = field(await request("/key", { apiKey, signal }), "data");
      return {
        name: stringOr(field(data, "name"), ""),
        usage: numberOr(field(data, "usage"), 0),
        limit: numberOrNull(field(data, "limit")),
        limitRemaining: numberOrNull(field(data, "limit_remaining")),
        limitReset: typeof field(data, "limit_reset") === "string" ? (field(data, "limit_reset") as string) : null,
        disabled: field(data, "disabled") === true,
      };
    },
    async exchangeCode(input, signal) {
      const json = await request("/auth/keys", {
        method: "POST",
        body: {
          code: input.code,
          code_verifier: input.codeVerifier,
          code_challenge_method: "S256",
          ...(input.callbackUrl === undefined ? {} : { callback_url: input.callbackUrl }),
        },
        signal,
      });
      const key = field(json, "key");
      if (typeof key !== "string" || key === "") {
        throw new RouterAiApiError("RouterAI returned no key", 502);
      }
      return key;
    },
  };
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[name] : undefined;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function errorCode(json: unknown): string | undefined {
  const error = field(json, "error");
  if (typeof error === "string") return error;
  const code = field(error, "code");
  return typeof code === "string" ? code : undefined;
}

function errorMessage(json: unknown): string | undefined {
  const description = field(json, "error_description");
  if (typeof description === "string") return description;
  const error = field(json, "error");
  if (typeof error === "string") return error;
  const message = field(error, "message");
  return typeof message === "string" ? message : undefined;
}
