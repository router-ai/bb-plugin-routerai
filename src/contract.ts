// Contract between the server part and the host part of the plugin.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const PROVIDER_ID = "routerai";

export const hostContract = defineRpcContract({
  /**
   * Stores the API key in a private file on the machine that runs the agent
   * (`null` removes it) and returns where it is. `rejected` records that
   * RouterAI turned the key down, so the provider reads as needing sign-in.
   */
  storeCredentials: {
    input: z.object({ apiKey: z.string().min(1).nullable(), rejected: z.boolean().optional() }).strict(),
    output: z.object({ path: z.string().min(1) }).strict(),
  },
  /** Whether the agent's command is on PATH on this machine. */
  agentInstalled: {
    input: z.object({}).strict(),
    output: z.object({ installed: z.boolean() }).strict(),
  },
  /**
   * Prepares the configuration directory Claude Code uses on this machine
   * when it runs through RouterAI, and returns where it is.
   */
  prepareClaudeConfig: {
    input: z.object({}).strict(),
    output: z.object({ path: z.string().min(1) }).strict(),
  },
});
