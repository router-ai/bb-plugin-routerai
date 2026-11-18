import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { credentialsPath, credentialsState, storeCredentials, writeClaudeConfig } from "../src/credentials-file.js";

describe("credentials file", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "routerai-cred-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the key readable by the owner only", async () => {
    const dataDir = path.join(dir, "host-data");
    const file = await storeCredentials(dataDir, "sk-test");
    expect(file).toBe(credentialsPath(dataDir));
    expect(await readFile(file, "utf8")).toBe("sk-test");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("replaces the key and removes it on sign-out", async () => {
    await storeCredentials(dir, "sk-old");
    const file = await storeCredentials(dir, "sk-new");
    expect(await readFile(file, "utf8")).toBe("sk-new");

    await storeCredentials(dir, null);
    await expect(stat(file)).rejects.toThrow();
    // Removing a key that is not there is not an error.
    await storeCredentials(dir, null);
  });

  it("tells a working key from a missing or a rejected one", async () => {
    expect(await credentialsState(dir)).toBe("missing");
    await storeCredentials(dir, "sk-test");
    expect(await credentialsState(dir)).toBe("ready");
    await storeCredentials(dir, "sk-test", true);
    expect(await credentialsState(dir)).toBe("rejected");
    // A fresh check that passes, or a new key, clears the mark.
    await storeCredentials(dir, "sk-test");
    expect(await credentialsState(dir)).toBe("ready");
    await storeCredentials(dir, "sk-test", true);
    await storeCredentials(dir, null);
    expect(await credentialsState(dir)).toBe("missing");
  });

  it("writes Claude Code settings that read the key from the key file", async () => {
    const directory = await writeClaudeConfig(dir, "linux");
    expect(directory).toBe(path.join(dir, "claude-code"));
    const settings = JSON.parse(await readFile(path.join(directory, "settings.json"), "utf8"));
    expect(settings).toEqual({ apiKeyHelper: `cat '${credentialsPath(dir)}'` });
    expect((await stat(path.join(directory, "settings.json"))).mode & 0o777).toBe(0o600);

    await writeClaudeConfig(dir, "win32");
    const onWindows = JSON.parse(await readFile(path.join(directory, "settings.json"), "utf8"));
    expect(onWindows.apiKeyHelper).toBe(`type "${credentialsPath(dir)}"`);
  });
});
