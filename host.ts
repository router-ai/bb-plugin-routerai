// bb-plugin-routerai — host entry (runs on the machine that runs the agent).
//
// The agent itself runs through the ACP bridge published in the bb SDK. Our
// own code here keeps the API key file for OpenCode, makes the thread spend
// reach bb in rubles and makes the provider's readiness follow the sign-in.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { experimental_acpProviderBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { AGENT_COMMAND, findOnPath } from "./src/agent-binary.js";
import { HealthCorrector } from "./src/bridge-health.js";
import { hostContract } from "./src/contract.js";
import { credentialsState, hostDataDirFromBridge, storeCredentials, writeClaudeConfig } from "./src/credentials-file.js";
import { relabelSpend } from "./src/spend-currency.js";

let health: HealthCorrector | null = null;

export const experimental_providerBridge: typeof experimental_acpProviderBridge = {
  ...experimental_acpProviderBridge,
  start(context) {
    const corrector = new HealthCorrector(() => credentialsState(hostDataDirFromBridge(context.dataDir)));
    health = corrector;
    // The bridge talks to bb over this process's stdout, a line per message.
    const write = process.stdout.write.bind(process.stdout) as (...args: unknown[]) => boolean;
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (typeof chunk !== "string") return write(chunk, ...rest);
      const corrected = corrector.correct(chunk);
      if (corrected === null) return write(relabelSpend(chunk), ...rest);
      void corrected.then((line) => write(line, ...rest));
      return true;
    }) as typeof process.stdout.write;
    experimental_acpProviderBridge.start?.(context);
  },
  handleLine(line) {
    health?.noteRequest(line);
    experimental_acpProviderBridge.handleLine(line);
  },
};

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    agentInstalled: async () => ({ installed: (await findOnPath(AGENT_COMMAND)) !== null }),
    prepareClaudeConfig: async (_input, context) => ({
      path: await writeClaudeConfig(context.experimental_paths.dataDir),
    }),
    storeCredentials: async ({ apiKey, rejected }, context) => ({
      path: await storeCredentials(context.experimental_paths.dataDir, apiKey, rejected ?? false),
    }),
  },
});
