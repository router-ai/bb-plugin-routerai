// Pure helpers of the frontend: number formatting and the model list editor's
// list operations. Kept free of React so they are tested directly.
import type { ModelInfo } from "./rpc.js";

/** "1 234,5 ₽" — rubles the way a Russian reader expects them. */
export function formatRub(value: number | null, fractionDigits = 2): string {
  if (value === null) return "—";
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: fractionDigits }).format(value)} ₽`;
}

/** Context window as "262K" or "1M". */
export function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  return `${Math.round(tokens / 1000)}K`;
}

/** "10,2 ₽ in · 20,4 ₽ out per 1M tokens". */
export function formatPrice(model: ModelInfo): string {
  return `${formatRub(model.price.input)} in · ${formatRub(model.price.output)} out per 1M tokens`;
}

const LIMIT_PERIODS: Record<string, string> = { daily: "a day", weekly: "a week", monthly: "a month" };

/** "799 ₽ left of 800 ₽ a day", or what to say when there is no limit. */
export function formatKeyLimit(key: {
  limit: number | null;
  limitRemaining: number | null;
  limitReset: string | null;
}): string {
  if (key.limit === null) return "No spend limit";
  const period = key.limitReset === null ? "" : ` ${LIMIT_PERIODS[key.limitReset] ?? key.limitReset}`;
  return `${formatRub(key.limitRemaining)} left of ${formatRub(key.limit)}${period}`;
}

/** Catalog models matching what the user typed, minus those already chosen. */
export function searchCatalog(
  catalog: readonly ModelInfo[],
  query: string,
  chosen: readonly string[],
  limit = 30,
): ModelInfo[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return [];
  const taken = new Set(chosen);
  const found: ModelInfo[] = [];
  for (const model of catalog) {
    if (taken.has(model.id)) continue;
    const haystack = `${model.id} ${model.name}`.toLowerCase();
    if (words.every((word) => haystack.includes(word))) {
      found.push(model);
      if (found.length === limit) break;
    }
  }
  return found;
}

/** Moves the item at `index` one place up (-1) or down (+1); a no-op at the ends. */
export function moveItem<T>(items: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return [...items];
  const next = [...items];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item as T);
  return next;
}

/** A thread's spend; anything under a kopeck still reads as spent. */
export function formatSpend(rubles: number): string {
  if (rubles > 0 && rubles < 0.01) return "< 0,01 ₽";
  return `${new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(rubles)} ₽`;
}
