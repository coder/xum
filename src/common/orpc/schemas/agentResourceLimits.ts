import { z } from "zod";
import { AgentResourceLimitsSchema } from "@/common/config/schemas/agentResourceLimits";

export const AgentResourceLimitsStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("off") }),
  /** `cgroup` is the cgroup v2 path that agent processes run in, such as `/xum/xum-agents`. */
  z.object({ state: z.literal("active"), cgroup: z.string() }),
  z.object({ state: z.literal("unavailable"), reason: z.string() }),
]);
export type AgentResourceLimitsStatus = z.infer<typeof AgentResourceLimitsStatusSchema>;

const AgentResourceLimitsStateSchema = z.object({
  /** When false, no limit applies, and `limits` stay saved for the next time it is true. */
  enabled: z.boolean(),
  limits: AgentResourceLimitsSchema,
  status: AgentResourceLimitsStatusSchema,
});
export type AgentResourceLimitsState = z.infer<typeof AgentResourceLimitsStateSchema>;

export const agentResourceLimits = {
  get: {
    input: z.void(),
    output: AgentResourceLimitsStateSchema,
  },
  /** Replaces both limits: an omitted field removes that limit. */
  set: {
    input: AgentResourceLimitsSchema,
    output: AgentResourceLimitsStateSchema,
  },
  /** Turns the limits on or off. It does not change them, so a concurrent `set` is kept. */
  setEnabled: {
    input: z.object({ enabled: z.boolean() }),
    output: AgentResourceLimitsStateSchema,
  },
};
