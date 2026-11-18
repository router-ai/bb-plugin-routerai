import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LoginSessions, buildAuthorizeUrl, createPkcePair, installationName, parsePastedCode } from "../src/routerai/oauth.js";

describe("PKCE", () => {
  it("derives the challenge from the verifier with SHA-256", () => {
    const { codeVerifier, codeChallenge } = createPkcePair();
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(codeChallenge).toBe(createHash("sha256").update(codeVerifier).digest("base64url"));
  });
});

describe("buildAuthorizeUrl", () => {
  it("sends the browser to RouterAI with the callback and a raised limit", () => {
    const url = new URL(
      buildAuthorizeUrl({ appName: "bb-laptop-3f9a", codeChallenge: "challenge", state: "st", callbackUrl: "http://127.0.0.1:38886/cb" }),
    );
    expect(url.origin + url.pathname).toBe("https://routerai.ru/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      callback_url: "http://127.0.0.1:38886/cb",
      code_challenge: "challenge",
      code_challenge_method: "S256",
      state: "st",
      app_name: "bb-laptop-3f9a",
      key_label: "bb-laptop-3f9a",
      limit: "1000",
      limit_period: "day",
    });
  });

  it("omits the callback for the manual flow", () => {
    const url = new URL(buildAuthorizeUrl({ appName: "bb-laptop-3f9a", codeChallenge: "challenge", state: "st" }));
    expect(url.searchParams.has("callback_url")).toBe(false);
  });
});

describe("parsePastedCode", () => {
  it("takes a bare code", () => {
    expect(parsePastedCode("  abc_DEF-123  ")).toEqual({ code: "abc_DEF-123" });
  });

  it("takes the callback address the browser could not open", () => {
    expect(
      parsePastedCode("http://127.0.0.1:38886/api/v1/plugins/routerai/http/oauth/callback?code=abc&state=st&iss=x"),
    ).toEqual({ code: "abc", state: "st" });
  });

  it("refuses text that is neither", () => {
    expect(parsePastedCode("")).toBeNull();
    expect(parsePastedCode("two words")).toBeNull();
    expect(parsePastedCode("http://127.0.0.1/cb?error=access_denied")).toBeNull();
  });
});

describe("LoginSessions", () => {
  it("hands a login out once by its state", () => {
    const sessions = new LoginSessions();
    const login = sessions.start({ appName: "bb-x", callbackUrl: "http://127.0.0.1/cb" });
    expect(new URL(login.authorizeUrl).searchParams.get("state")).toBe(login.state);
    expect(sessions.take(login.state)?.codeVerifier).toBe(login.codeVerifier);
    expect(sessions.take(login.state)).toBeNull();
  });

  it("gives the newest login to a code pasted without a state", () => {
    let now = 0;
    const sessions = new LoginSessions(() => now);
    sessions.start({ appName: "bb-x" });
    now = 1000;
    const newest = sessions.start({ appName: "bb-x" });
    expect(sessions.takeLatest()?.state).toBe(newest.state);
  });

  it("forgets logins older than ten minutes", () => {
    let now = 0;
    const sessions = new LoginSessions(() => now);
    const login = sessions.start({ appName: "bb-x" });
    now = 10 * 60_000 + 1;
    expect(sessions.take(login.state)).toBeNull();
    expect(sessions.takeLatest()).toBeNull();
  });
});

describe("installationName", () => {
  it("names the installation after its machine, with a tail that tells namesakes apart", () => {
    expect(installationName("Konstantin's MacBook-Pro.local", "3f9a")).toBe("bb-konstantin-s-macbook-pro-3f9a");
    expect(installationName("srv", "00ff")).toBe("bb-srv-00ff");
    expect(installationName("", "00ff")).toBe("bb-00ff");
    expect(installationName("a-very-long-machine-name-that-goes-on.example.org", "1")).toBe("bb-a-very-long-machine-name-1");
  });

  it("differs between two installations on machines with the same name", () => {
    expect(installationName("localhost")).not.toBe(installationName("localhost"));
  });
});
