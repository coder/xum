import { z } from "zod";
import { AgentResourceLimitsSchema } from "@/common/config/schemas/agentResourceLimits";

export const AgentResourceLimitsStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("off") }),
  /** `cgroup` is the cgroup v2 path that agent processes run in, such as `/xum/xum-agents`. */
  z.object({ state: z.literal("active"), cgroup: z.string() }),
  z.object({ state: z.literal("unavailable"), reason: z.string() }),
]);
export type AgentResourceLimitsStatus = z.infer<typeof AgentResourceLimitsStatusSchema>;

/**
 * What applying the saved limits takes where the backend runs now. The backend checks it without
 * changing anything, so clients can show it before the limits are turned on.
 */
export const AgentResourceLimitsSupportSchema = z.discriminatedUnion("state", [
  /** No limit can apply on this OS or kernel, for example on macOS and Windows. */
  z.object({ state: z.literal("unsupported"), reason: z.string() }),
  /** Limits cannot apply where xum runs now; `reason` says what to change. */
  z.object({ state: z.literal("unavailable"), reason: z.string() }),
  /** Agent processes join the `xum-agents` child of the base cgroup `cgroup`. */
  z.object({ state: z.literal("ready"), cgroup: z.string() }),
  /**
   * As for ready, but xum first gives `cgroup` to its user with `sudo -n`, and then moves every
   * process of `cgroup`, also those of other users, into its child `xum-app`.
   */
  z.object({ state: z.literal("sudo"), cgroup: z.string() }),
]);
export type AgentResourceLimitsSupport = z.infer<typeof AgentResourceLimitsSupportSchema>;

const AgentResourceLimitsStateSchema = z.object({
  /** When false, no limit applies, and `limits` stay saved for the next time it is true. */
  enabled: z.boolean(),
  limits: AgentResourceLimitsSchema,
  /**
   * The saved limits of each project with a limit of its own, keyed by project path. `cgroup` is
   * the cgroup its agent commands run in, while the limits are active.
   */
  projects: z.record(
    z.string(),
    z.object({ limits: AgentResourceLimitsSchema, cgroup: z.string().optional() })
  ),
  status: AgentResourceLimitsStatusSchema,
  support: AgentResourceLimitsSupportSchema,
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
  /** Replaces both limits of one project: an omitted field removes that limit. */
  setProject: {
    input: z.object({ projectPath: z.string(), limits: AgentResourceLimitsSchema }),
    output: AgentResourceLimitsStateSchema,
  },
  /** Turns the limits on or off. It does not change them, so a concurrent `set` is kept. */
  setEnabled: {
    input: z.object({ enabled: z.boolean() }),
    output: AgentResourceLimitsStateSchema,
  },
};
