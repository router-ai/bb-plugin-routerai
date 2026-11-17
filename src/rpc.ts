// Contract between the plugin's frontend (app.tsx) and its server part.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** Realtime channel the server signals on whenever the status may differ. */
export const CHANGED_CHANNEL = "changed";

const modelSchema = z.object({
  id: z.string(),
  name: z.string(),
  contextLength: z.number(),
  price: z.object({ input: z.number(), output: z.number(), cacheRead: z.number().optional(), cacheWrite: z.number().optional() }),
  reasoning: z.boolean(),
  vision: z.boolean(),
});

const accountSchema = z.discriminatedUnion("signedIn", [
  z.object({ signedIn: z.literal(false) }),
  z.object({
    signedIn: z.literal(true),
    balance: z.number().nullable(),
    key: z
      .object({
        name: z.string(),
        usage: z.number(),
        limit: z.number().nullable(),
        limitRemaining: z.number().nullable(),
        limitReset: z.string().nullable(),
        disabled: z.boolean(),
      })
      .nullable(),
    problem: z.object({ kind: z.enum(["rejected", "unreachable"]), message: z.string() }).optional(),
  }),
]);

const empty = z.object({}).strict();

export const rpcContract = defineRpcContract({
  status: {
    input: empty,
    output: z.object({
      account: accountSchema,
      /** Picker models in order; the first is the default. */
      models: z.array(modelSchema),
      /** Chosen slugs the catalog no longer has. */
      missing: z.array(z.string()),
      /** True while the starter set is offered because nothing was chosen. */
      usingStarterSet: z.boolean(),
    }),
  },
  catalog: {
    input: empty,
    output: z.object({ models: z.array(modelSchema) }),
  },
  setModels: {
    input: z.object({ ids: z.array(z.string()).max(100) }).strict(),
    output: empty,
  },
  startLogin: {
    input: z.object({ manual: z.boolean() }).strict(),
    output: z.object({ authorizeUrl: z.string(), manual: z.boolean() }),
  },
  completeLogin: {
    input: z.object({ pasted: z.string().min(1).max(4096) }).strict(),
    output: empty,
  },
  logout: {
    input: empty,
    output: empty,
  },
});

export type StatusResult = z.infer<(typeof rpcContract)["status"]["output"]>;
export type ModelInfo = z.infer<typeof modelSchema>;
export type AccountInfo = z.infer<typeof accountSchema>;
