import { tool } from "ai";

import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import type { AgentSkillReadToolResult } from "@/common/types/tools";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { SkillNameSchema } from "@/common/orpc/schemas";
import { getErrorMessage } from "@/common/utils/errors";
import { readAgentSkill } from "@/node/services/agentSkills/agentSkillsService";
import { resolveSkillStorageContext } from "@/node/services/agentSkills/skillStorageContext";
import { contextListingPointer } from "@/node/services/contextListing";

const SKILL_READ_FILE_HINT = `To read referenced files inside a skill directory:\n- agent_skill_read_file({ name: "<skill-name>", filePath: "references/whatever.txt" })`;

/**
 * Static agent_skill_read description. Skills can be added or edited during a
 * workspace's life, so the skill index travels in the durable context listing
 * row (prompt-cache stability, #5248); see formatSkillIndexSection.
 */
const SKILL_READ_DESCRIPTION = `${TOOL_DEFINITIONS.agent_skill_read.description}\n\n${contextListingPointer("Available skills")}\n${SKILL_READ_FILE_HINT}`;

/** Render the skill index section of the context listing ("" when none are advertised). */
export function formatSkillIndexSection(availableSkills: readonly AgentSkillDescriptor[]): string {
  // Filter out unadvertised skills (advertise: false or disable-model-invocation: true,
  // normalized into descriptor.advertise). Unadvertised skills can still be invoked
  // via /skill-name or agent_skill_read.
  const skills = availableSkills.filter((s) => s.advertise !== false);

  if (skills.length === 0) {
    return "";
  }

  const MAX_SKILLS = 50;
  const shown = skills.slice(0, MAX_SKILLS);
  const omitted = skills.length - shown.length;

  const skillLines = shown.map((skill) => {
    const line = `- ${skill.name}: ${skill.description} (scope: ${skill.scope})`;
    // whenToUse (when_to_use/when-to-use frontmatter) is extra model-facing guidance;
    // keep it on the same index line to stay token-lean.
    return skill.whenToUse == null ? line : `${line} When to use: ${skill.whenToUse}`;
  });
  if (omitted > 0) {
    skillLines.push(`(+${omitted} more not shown)`);
  }
  return skillLines.join("\n");
}

/**
 * Agent Skill read tool factory.
 * Reads and validates a skill's SKILL.md from project-local or global skills roots.
 */
export const createAgentSkillReadTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: SKILL_READ_DESCRIPTION,
    inputSchema: TOOL_DEFINITIONS.agent_skill_read.schema,
    execute: async ({ name }): Promise<AgentSkillReadToolResult> => {
      const workspacePath = config.cwd;
      if (!workspacePath) {
        return {
          success: false,
          error: "Tool misconfigured: cwd is required.",
        };
      }

      // Defensive: validate again even though inputSchema should guarantee shape.
      const parsedName = SkillNameSchema.safeParse(name);
      if (!parsedName.success) {
        return {
          success: false,
          error: parsedName.error.message,
        };
      }

      try {
        // claude-skills-compat experiment: allow reading skills discovered from .claude roots.
        const includeClaudeSkills = config.experiments?.claudeSkillsCompat === true;
        // agent-plugins experiment: allow reading skills discovered from Agent Plugins.
        const includeAgentPlugins = config.experiments?.agentPlugins === true;
        const skillCtx = resolveSkillStorageContext({
          runtime: config.runtime,
          workspacePath,
          xumScope: config.xumScope ?? null,
          includeClaudeSkills,
          includeAgentPlugins,
        });
        const resolved = await readAgentSkill(
          skillCtx.runtime,
          skillCtx.workspacePath,
          parsedName.data,
          {
            roots: skillCtx.roots,
            containment: skillCtx.containment,
            includeClaudeSkills,
            includeAgentPlugins,
          }
        );
        return {
          success: true,
          skill: resolved.package,
        };
      } catch (error) {
        return {
          success: false,
          error: getErrorMessage(error),
        };
      }
    },
  });
};
