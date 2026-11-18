import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findOnPath } from "../src/agent-binary.js";

describe("findOnPath", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "routerai-path-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("finds an executable in one of the PATH directories", async () => {
    const file = path.join(dir, "opencode");
    await writeFile(file, "#!/bin/sh\n");
    await chmod(file, 0o755);
    expect(await findOnPath("opencode", { PATH: `/nonexistent:${dir}` }, "linux")).toBe(file);
  });

  it("does not take a file that cannot be run, or an empty PATH", async () => {
    const file = path.join(dir, "opencode");
    await writeFile(file, "");
    await chmod(file, 0o644);
    expect(await findOnPath("opencode", { PATH: dir }, "linux")).toBeNull();
    expect(await findOnPath("opencode", {}, "linux")).toBeNull();
  });
});
