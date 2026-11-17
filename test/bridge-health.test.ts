import { describe, expect, it } from "vitest";
import { HealthCorrector } from "../src/bridge-health.js";
import type { CredentialsState } from "../src/credentials-file.js";

const request = (id: number, method = "provider/health") => JSON.stringify({ jsonrpc: "2.0", id, method, params: {} });
const answer = (id: number, status: string) =>
  `${JSON.stringify({ jsonrpc: "2.0", id, result: { supported: true, health: { status, installedVersion: "1.19.5" } } })}\n`;

function corrector(state: CredentialsState) {
  return new HealthCorrector(async () => state);
}

describe("HealthCorrector", () => {
  it("keeps a ready answer while the machine holds a working key", async () => {
    const health = corrector("ready");
    health.noteRequest(request(1));
    expect(await health.correct(answer(1, "ready"))).toBe(answer(1, "ready"));
  });

  it("reports not signed in without a key file and expired for a rejected key", async () => {
    const missing = corrector("missing");
    missing.noteRequest(request(1));
    expect(await missing.correct(answer(1, "ready"))).toBe(answer(1, "unauthenticated"));

    const rejected = corrector("rejected");
    rejected.noteRequest(request(2));
    expect(await rejected.correct(answer(2, "ready"))).toBe(answer(2, "expired"));
  });

  it("leaves the bridge's own bad news alone", () => {
    const health = corrector("missing");
    health.noteRequest(request(1));
    expect(health.correct(answer(1, "not_installed"))).toBeNull();
  });

  it("touches only answers to health requests, each once", async () => {
    const health = corrector("missing");
    health.noteRequest(request(1, "model/list"));
    expect(health.correct(answer(1, "ready"))).toBeNull();
    health.noteRequest(request(2));
    expect(health.correct(answer(3, "ready"))).toBeNull();
    expect(await health.correct(answer(2, "ready"))).toBe(answer(2, "unauthenticated"));
    expect(health.correct(answer(2, "ready"))).toBeNull();
  });

  it("passes the answer through when the key state cannot be read", async () => {
    const health = new HealthCorrector(async () => {
      throw new Error("EACCES");
    });
    health.noteRequest(request(1));
    expect(await health.correct(answer(1, "ready"))).toBe(answer(1, "ready"));
  });
});
