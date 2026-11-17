// Makes the provider's readiness reflect the RouterAI sign-in.
//
// The ACP bridge calls a provider ready as soon as OpenCode is installed; it
// knows nothing of our key. Here its answer to `provider/health` is corrected
// from what this machine holds: no key file means "not signed in", a rejected
// key means "expired". bb then shows the provider's sign-in hint in the picker
// instead of letting a thread start and fail with a 401. The server part may
// still overrule "not signed in" by delivering the key (see server.ts).
import type { CredentialsState } from "./credentials-file.js";

const HEALTH_METHOD = "provider/health";

type JsonRpcId = string | number;

/** Tracks health requests on their way in and corrects the answers going out. */
export class HealthCorrector {
  private readonly pending = new Set<JsonRpcId>();

  constructor(private readonly state: () => Promise<CredentialsState>) {}

  /** Call with every line bb sends to the bridge. */
  noteRequest(line: string): void {
    if (!line.includes(HEALTH_METHOD)) return;
    try {
      const request = JSON.parse(line) as { id?: unknown; method?: unknown };
      if (request.method === HEALTH_METHOD && isId(request.id)) this.pending.add(request.id);
    } catch {
      // Not ours to judge; the bridge reports malformed input itself.
    }
  }

  /**
   * Call with every line the bridge sends to bb. Returns null for a line that
   * is no health answer, otherwise the line to send in its place.
   */
  correct(line: string): Promise<string> | null {
    if (this.pending.size === 0 || !line.includes('"health"')) return null;
    let message: { id?: unknown; result?: { health?: { status?: unknown } } };
    try {
      message = JSON.parse(line);
    } catch {
      return null;
    }
    if (!isId(message.id) || !this.pending.delete(message.id)) return null;
    const health = message.result?.health;
    // Not installed, unknown: the bridge's own verdict comes first.
    if (health === undefined || health.status !== "ready") return null;
    return this.state().then(
      (state) => {
        if (state === "ready") return line;
        health.status = state === "rejected" ? "expired" : "unauthenticated";
        return `${JSON.stringify(message)}\n`;
      },
      () => line,
    );
  }
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || typeof value === "number";
}
