import { z } from "zod";
import { AgentSkillPackageSchema } from "@/common/orpc/schemas/agentSkill";

// Its own module because the renderer entry (StreamingMessageAggregator) parses this result:
// importing it from toolDefinitions.ts put every tool schema on every page's first load, about
// 24 KB of brotli a phone downloads before the composer works (#5971). toolDefinitions.ts
// re-exports it.

/**
 * Agent Skill read tool result - full SKILL.md package or error.
 */
export const AgentSkillReadToolResultSchema = z.union([
  z.object({
    success: z.literal(true),
    skill: AgentSkillPackageSchema,
    // Optional: results persisted before these fields existed lack them.
    /** Absolute skill directory, valid where the workspace's bash runs. */
    skillDir: z.string().optional(),
    /** Agent Plugin skills only: absolute plugin root, valid where bash runs. */
    pluginRoot: z.string().optional(),
    /** Why `skillDir` is absent (built-in skill, or files not where bash runs). */
    skillDirUnavailable: z.string().optional(),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
]);
