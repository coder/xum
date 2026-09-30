import { z } from "zod";

export const TASK_SETTINGS_LIMITS = {
  maxParallelAgentTasks: { min: 1, max: 256, default: 16 },
  maxTaskNestingDepth: { min: 1, max: 5, default: 3 },
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
