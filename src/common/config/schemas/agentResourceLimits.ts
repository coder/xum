import { z } from "zod";

export const AGENT_RESOURCE_LIMITS_RANGE = {
  cpuCores: { min: 0.1, max: 1024 },
  memoryGiB: { min: 0.25, max: 16384 },
} as const;

/** Limits that all local agent processes share. An absent field means no limit. */
export const AgentResourceLimitsSchema = z.object({
  cpuCores: z
    .number()
    .min(AGENT_RESOURCE_LIMITS_RANGE.cpuCores.min)
    .max(AGENT_RESOURCE_LIMITS_RANGE.cpuCores.max)
    .optional(),
  memoryGiB: z
    .number()
    .min(AGENT_RESOURCE_LIMITS_RANGE.memoryGiB.min)
    .max(AGENT_RESOURCE_LIMITS_RANGE.memoryGiB.max)
    .optional(),
});

export type AgentResourceLimits = z.infer<typeof AgentResourceLimitsSchema>;

/** The stored limits, or undefined when none is set or the stored value is invalid. */
export function normalizeAgentResourceLimits(value: unknown): AgentResourceLimits | undefined {
  const parsed = AgentResourceLimitsSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const { cpuCores, memoryGiB } = parsed.data;
  if (cpuCores === undefined && memoryGiB === undefined) {
    return undefined;
  }
  return {
    ...(cpuCores !== undefined ? { cpuCores } : {}),
    ...(memoryGiB !== undefined ? { memoryGiB } : {}),
  };
}
