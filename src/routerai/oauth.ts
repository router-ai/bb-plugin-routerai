// "Sign in with RouterAI": OAuth with PKCE. RouterAI needs no app
// registration; the code is traded for an ordinary API key.
import { createHash, randomBytes } from "node:crypto";
import { ROUTERAI_SITE_URL } from "./api.js";

/**
 * The name this bb installation signs in under, and the name of its key.
 * RouterAI keeps one key per application name and reissues it on every
 * sign-in, so a name shared by all installations would let a sign-in on one
 * machine revoke the key of another. The machine name makes the key easy to
 * recognise in the RouterAI key list; the random tail tells apart
 * installations whose machines are named alike.
 */
export function installationName(hostname: string, tail: string = randomBytes(2).toString("hex")): string {
  const machine = hostname
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/, "");
  return ["bb", machine, tail].filter((part) => part !== "").join("-");
}

/** RouterAI's own default is 100 ₽ a day, too little for agent work. */
const SUGGESTED_LIMIT_RUB = 1000;
const LOGIN_TTL_MS = 10 * 60_000;

export interface PendingLogin {
  state: string;
  codeVerifier: string;
  /** Absent for the manual flow: RouterAI shows the code on screen. */
  callbackUrl?: string;
  authorizeUrl: string;
  createdAt: number;
}

export function createPkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

export function buildAuthorizeUrl(input: {
  /** See {@link installationName}. */
  appName: string;
  codeChallenge: string;
  state: string;
  callbackUrl?: string;
  siteUrl?: string;
}): string {
  const url = new URL("/auth", input.siteUrl ?? ROUTERAI_SITE_URL);
  if (input.callbackUrl !== undefined) url.searchParams.set("callback_url", input.callbackUrl);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", input.state);
  url.searchParams.set("app_name", input.appName);
  url.searchParams.set("key_label", input.appName);
  url.searchParams.set("limit", String(SUGGESTED_LIMIT_RUB));
  url.searchParams.set("limit_period", "day");
  return url.toString();
}

/**
 * Accepts what a user may paste after consenting: the bare code, or the
 * whole address the browser was sent to.
 */
export function parsePastedCode(pasted: string): { code: string; state?: string } | null {
  const value = pasted.trim();
  if (value === "") return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.includes("code=")) {
    let params: URLSearchParams;
    try {
      params = new URL(value).searchParams;
    } catch {
      params = new URLSearchParams(value.slice(value.indexOf("?") + 1));
    }
    const code = params.get("code");
    if (code === null || code === "") return null;
    const state = params.get("state");
    return { code, ...(state === null ? {} : { state }) };
  }
  return /\s/.test(value) ? null : { code: value };
}

/** Sign-ins that were started and not finished yet. They live in memory only. */
export class LoginSessions {
  private readonly pending = new Map<string, PendingLogin>();

  constructor(private readonly now: () => number = Date.now) {}

  start(options: { appName: string; callbackUrl?: string; siteUrl?: string }): PendingLogin {
    this.dropExpired();
    const { codeVerifier, codeChallenge } = createPkcePair();
    const state = randomBytes(18).toString("base64url");
    const login: PendingLogin = {
      state,
      codeVerifier,
      ...(options.callbackUrl === undefined ? {} : { callbackUrl: options.callbackUrl }),
      authorizeUrl: buildAuthorizeUrl({
        appName: options.appName,
        codeChallenge,
        state,
        ...(options.callbackUrl === undefined ? {} : { callbackUrl: options.callbackUrl }),
        ...(options.siteUrl === undefined ? {} : { siteUrl: options.siteUrl }),
      }),
      createdAt: this.now(),
    };
    this.pending.set(state, login);
    return login;
  }

  /** Removes and returns the login for a `state`; a state is good once. */
  take(state: string): PendingLogin | null {
    this.dropExpired();
    const login = this.pending.get(state) ?? null;
    if (login !== null) this.pending.delete(state);
    return login;
  }

  /** The newest unfinished login: a pasted bare code carries no state. */
  takeLatest(): PendingLogin | null {
    this.dropExpired();
    let latest: PendingLogin | null = null;
    for (const login of this.pending.values()) {
      if (latest === null || login.createdAt >= latest.createdAt) latest = login;
    }
    if (latest !== null) this.pending.delete(latest.state);
    return latest;
  }

  private dropExpired(): void {
    const cutoff = this.now() - LOGIN_TTL_MS;
    for (const [state, login] of this.pending) {
      if (login.createdAt < cutoff) this.pending.delete(state);
    }
  }
}
