import { z } from "zod";

// Defaults sized for orchestration playbooks (e.g. pstack's Orchestrate/Autopilot): a root,
// per-track coordinators, workers and their verifiers/reviewers nest 4 levels below the root,
// and fleets outgrow 16 concurrent tasks. Depth 5 leaves one level of headroom; the depth limit
// only guards runaway recursion. Each active task costs its own workspace, model stream
// (provider rate limits) and MCP server set, so the parallel default stays far below the max.
// Foreground-awaiting parents do not count as active, so deep chains do not eat this budget.
export const TASK_SETTINGS_LIMITS = {
  maxParallelAgentTasks: { min: 1, max: 256, default: 32 },
  maxTaskNestingDepth: { min: 1, max: 5, default: 5 },
} as const;

/**
 * Defaults before TASK_SETTINGS_LIMITS raised them. Every config save writes the normalized
 * task settings, so on disk these values almost always mean "Xum wrote the default", not "the
 * user chose it". The one-time `taskSettingsDefaultsRaised` migration moves exactly these values.
 */
export const PREVIOUS_TASK_SETTINGS_DEFAULTS = {
  maxParallelAgentTasks: 16,
  maxTaskNestingDepth: 3,
} as const;

export const TaskSettingsSchema = z.object({
  maxParallelAgentTasks: z
    .number()
    .int()
    .min(TASK_SETTINGS_LIMITS.maxParallelAgentTasks.min)
    .max(TASK_SETTINGS_LIMITS.maxParallelAgentTasks.max)
    .optional(),
  maxTaskNestingDepth: z
    .number()
    .int()
    .min(TASK_SETTINGS_LIMITS.maxTaskNestingDepth.min)
    .max(TASK_SETTINGS_LIMITS.maxTaskNestingDepth.max)
    .optional(),
  proposePlanImplementReplacesChatHistory: z.boolean().optional(),
  preserveSubagentsUntilArchive: z.boolean().optional(),
});

export type TaskSettings = z.infer<typeof TaskSettingsSchema>;
