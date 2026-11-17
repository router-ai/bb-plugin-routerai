// The RouterAI model catalog, reduced to what the plugin needs: which models
// can drive a coding agent, their context window and ruble prices.
import type { RouterAiApi } from "./api.js";

export interface RouterAiModel {
  /** Catalog slug, `<author>/<model>`. */
  id: string;
  name: string;
  description: string;
  /** Context window, tokens. */
  contextLength: number;
  /** Rubles per million tokens. */
  price: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  reasoning: boolean;
  /** Accepts images in the prompt. */
  vision: boolean;
}

/** Offered until the user picks their own list. The first one is the default. */
export const STARTER_MODEL_IDS: readonly string[] = [
  "deepseek/deepseek-v4-flash",
  "anthropic/claude-sonnet-5.5",
  "openai/gpt-5.4-mini",
  "moonshotai/kimi-k2.7-code",
];

const SLUG = /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function isModelSlug(value: string): boolean {
  return SLUG.test(value);
}

/**
 * Keeps the catalog entries an agent can run on: text out, tool calls
 * supported, priced per token. Malformed entries are skipped, not fatal.
 */
export function parseCatalog(entries: readonly unknown[]): RouterAiModel[] {
  const models: RouterAiModel[] = [];
  for (const entry of entries) {
    const model = parseEntry(entry);
    if (model !== null) models.push(model);
  }
  return models;
}

function parseEntry(entry: unknown): RouterAiModel | null {
  if (typeof entry !== "object" || entry === null) return null;
  const raw = entry as Record<string, unknown>;
  const id = raw.id;
  if (typeof id !== "string" || !isModelSlug(id)) return null;

  const architecture = record(raw.architecture);
  const outputs = strings(architecture.output_modalities);
  const inputs = strings(architecture.input_modalities);
  const parameters = strings(raw.supported_parameters);
  if (!outputs.includes("text") || !parameters.includes("tools")) return null;

  const pricing = record(raw.pricing);
  const units = record(raw.pricing_units);
  const input = perMillion(pricing.prompt, units.prompt);
  const output = perMillion(pricing.completion, units.completion);
  if (input === null || output === null) return null;
  const cacheRead = perMillion(pricing.input_cache_read, units.input_cache_read);
  const cacheWrite = perMillion(pricing.input_cache_write, units.input_cache_write);

  const contextLength = raw.context_length;
  if (typeof contextLength !== "number" || !(contextLength > 0)) return null;

  return {
    id,
    name: typeof raw.name === "string" && raw.name !== "" ? raw.name : id,
    description: typeof raw.description === "string" ? raw.description : "",
    contextLength,
    price: {
      input,
      output,
      ...(cacheRead === null ? {} : { cacheRead }),
      ...(cacheWrite === null ? {} : { cacheWrite }),
    },
    reasoning: parameters.includes("reasoning"),
    vision: inputs.includes("image"),
  };
}

function perMillion(price: unknown, unit: unknown): number | null {
  if (typeof price !== "number" || !Number.isFinite(price) || price < 0) return null;
  // A missing unit means the catalog's default, a token.
  if (unit !== undefined && unit !== "token") return null;
  return Math.round(price * 1_000_000 * 1000) / 1000;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Parses the `models` setting: a JSON array of slugs. Bad input yields `[]`. */
export function parseModelList(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (typeof item === "string" && isModelSlug(item)) seen.add(item);
  }
  return [...seen];
}

/**
 * The models the picker offers, in the user's order. A chosen slug the
 * catalog no longer lists is reported in `missing` and left out.
 */
export function selectPickerModels(
  catalog: readonly RouterAiModel[],
  chosen: readonly string[],
): { models: RouterAiModel[]; missing: string[] } {
  const byId = new Map(catalog.map((model) => [model.id, model]));
  const wanted = chosen.length > 0 ? chosen : STARTER_MODEL_IDS;
  const models: RouterAiModel[] = [];
  const missing: string[] = [];
  for (const id of wanted) {
    const model = byId.get(id);
    if (model === undefined) missing.push(id);
    else models.push(model);
  }
  return { models, missing: chosen.length > 0 ? missing : [] };
}

const CATALOG_TTL_MS = 10 * 60_000;

/** Caches the catalog; a failed refresh keeps serving the last good copy. */
export class CatalogStore {
  private models: RouterAiModel[] | null = null;
  private fetchedAt = 0;
  private pending: Promise<RouterAiModel[]> | null = null;

  constructor(
    private readonly api: RouterAiApi,
    private readonly now: () => number = Date.now,
  ) {}

  async list(): Promise<RouterAiModel[]> {
    if (this.models !== null && this.now() - this.fetchedAt < CATALOG_TTL_MS) return this.models;
    this.pending ??= this.refresh().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** Forget the cached copy, e.g. after the base URL changed. */
  reset(): void {
    this.models = null;
    this.fetchedAt = 0;
  }

  private async refresh(): Promise<RouterAiModel[]> {
    try {
      const models = parseCatalog(await this.api.listModels());
      this.models = models;
      this.fetchedAt = this.now();
      return models;
    } catch (error) {
      if (this.models !== null) return this.models;
      throw error;
    }
  }
}
