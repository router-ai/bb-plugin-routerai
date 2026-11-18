// Host side: is the agent the provider launches on this machine at all?
import { access, constants } from "node:fs/promises";
import path from "node:path";

/** The command the provider launches; `opencode acp` speaks ACP. */
export const AGENT_COMMAND = "opencode";

/** Looks the command up on PATH the way a launch would, without running it. */
export async function findOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const windows = platform === "win32";
  const extensions = windows ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
  const delimiter = windows ? ";" : ":";
  for (const directory of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (directory === "") continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, command + extension);
      try {
        await access(candidate, windows ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return null;
}
