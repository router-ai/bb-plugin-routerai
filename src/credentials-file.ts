// Host side: the API key file OpenCode reads, private to the user (0600),
// and a marker beside it that says RouterAI turned that key down.
import { randomUUID } from "node:crypto";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const FILE_NAME = "credentials";
const REJECTED_MARKER = "credentials.rejected";

export function credentialsPath(dataDir: string): string {
  return path.join(dataDir, FILE_NAME);
}

/** Stores the key (`null` removes it) and records whether RouterAI rejected it. */
export async function storeCredentials(dataDir: string, apiKey: string | null, rejected = false): Promise<string> {
  const target = credentialsPath(dataDir);
  const marker = path.join(dataDir, REJECTED_MARKER);
  if (apiKey === null) {
    await Promise.all([rm(target, { force: true }), rm(marker, { force: true })]);
    return target;
  }
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  // Write beside and rename, so a reader never sees half a key. The name is
  // unique: two writes for the same machine may overlap.
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, apiKey, { mode: 0o600 });
  await rename(temporary, target);
  if (rejected) await writeFile(marker, "", { mode: 0o600 });
  else await rm(marker, { force: true });
  return target;
}

/**
 * The directory the key file is in, as seen from the provider bridge. bb gives
 * the bridge and the host entry sibling directories of the plugin's own
 * (`bridge-data` and `host-data`) and names neither to the other. Should that
 * layout change, the bridge finds no key and reports "not signed in"; the
 * server part then vouches for a working key, so only the distinction between
 * a missing and a rejected key is lost.
 */
export function hostDataDirFromBridge(bridgeDataDir: string): string {
  return path.join(path.dirname(bridgeDataDir), "host-data");
}

export type CredentialsState = "ready" | "missing" | "rejected";

/** What this machine knows about the key, without asking RouterAI. */
export async function credentialsState(dataDir: string): Promise<CredentialsState> {
  if (!(await exists(credentialsPath(dataDir)))) return "missing";
  return (await exists(path.join(dataDir, REJECTED_MARKER))) ? "rejected" : "ready";
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
