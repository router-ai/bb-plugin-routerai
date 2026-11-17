// What the plugin knows about the signed-in RouterAI account.
import { RouterAiApiError, type RouterAiApi, type RouterAiKeyInfo } from "./routerai/api.js";

export type AccountStatus =
  | { signedIn: false }
  | {
      signedIn: true;
      /** Account balance, rubles; `null` when RouterAI could not be asked. */
      balance: number | null;
      key: RouterAiKeyInfo | null;
      /** Set when the key was rejected or RouterAI was unreachable. */
      problem?: { kind: "rejected" | "unreachable"; message: string };
    };

const STATUS_TTL_MS = 20_000;

/** Reads balance and key limits, briefly cached so the UI can poll freely. */
export class AccountStore {
  private cached: { key: string; at: number; status: AccountStatus } | null = null;

  constructor(
    private readonly api: RouterAiApi,
    private readonly now: () => number = Date.now,
  ) {}

  reset(): void {
    this.cached = null;
  }

  /** Whether the last answer for this key was a rejection; asks nobody. */
  knownRejected(apiKey: string): boolean {
    const status = this.cached?.key === apiKey ? this.cached.status : null;
    return status !== null && status.signedIn && status.problem?.kind === "rejected";
  }

  async status(apiKey: string | undefined): Promise<AccountStatus> {
    if (apiKey === undefined || apiKey === "") return { signedIn: false };
    const cached = this.cached;
    if (cached !== null && cached.key === apiKey && this.now() - cached.at < STATUS_TTL_MS) {
      return cached.status;
    }
    const status = await this.read(apiKey);
    this.cached = { key: apiKey, at: this.now(), status };
    return status;
  }

  private async read(apiKey: string): Promise<AccountStatus> {
    try {
      const [credits, key] = await Promise.all([this.api.credits(apiKey), this.api.keyInfo(apiKey)]);
      return { signedIn: true, balance: credits.credits, key };
    } catch (error) {
      const rejected = error instanceof RouterAiApiError && error.unauthorized;
      return {
        signedIn: true,
        balance: null,
        key: null,
        problem: {
          kind: rejected ? "rejected" : "unreachable",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}
