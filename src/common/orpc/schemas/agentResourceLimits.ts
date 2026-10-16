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
  limits: AgentResourceLimitsSchema,
  status: AgentResourceLimitsStatusSchema,
});

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
};
