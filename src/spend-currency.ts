// Puts the right currency on the thread spend the agent reports.
//
// OpenCode adds up a thread's spend from the model prices it is given and
// labels the sum "USD" unconditionally. Our prices are in rubles, so the sum
// is a ruble amount with the wrong label. The bridge sends bb one JSON
// message per line; a spend travels in a `contextWindow` thread delta, next
// to the context size. Those get their currency corrected here, every other
// line passes through untouched.

export const SPEND_CURRENCY = "RUB";

/** Present in every line that carries a spend, so other lines skip parsing. */
const MARKER = '"contextWindow"';
const AGENT_CURRENCY = "USD";

/** Returns the line with the spend currency corrected, or the line itself. */
export function relabelSpend(line: string): string {
  if (!line.includes(MARKER)) return line;
  const newline = line.endsWith("\n") ? "\n" : "";
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return line;
  }
  return relabel(message) ? JSON.stringify(message) + newline : line;
}

/** Walks the message and fixes each spend found; true when one changed. */
function relabel(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  let changed = false;
  const delta = value as { kind?: unknown; cost?: { currency?: unknown } | null };
  if (delta.kind === "contextWindow" && typeof delta.cost === "object" && delta.cost !== null) {
    if (delta.cost.currency === AGENT_CURRENCY) {
      delta.cost.currency = SPEND_CURRENCY;
      changed = true;
    }
    return changed;
  }
  for (const child of Object.values(value)) {
    if (relabel(child)) changed = true;
  }
  return changed;
}
