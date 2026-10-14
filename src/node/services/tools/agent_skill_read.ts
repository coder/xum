import { tool } from "ai";

import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import type { AgentSkillReadToolResult } from "@/common/types/tools";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { AGENT_SKILL_INDEX_DESCRIPTION_MAX_CHARS } from "@/common/constants/toolLimits";
import { parseSkillLookupName } from "@/common/utils/agentSkills/skillLookupName";
import { getErrorMessage } from "@/common/utils/errors";
import type { Runtime } from "@/node/runtime/Runtime";
import {
  readAgentSkill,
  type ResolvedAgentSkill,
} from "@/node/services/agentSkills/agentSkillsService";
import { resolveSkillStorageContext } from "@/node/services/agentSkills/skillStorageContext";
import {
  resolveSkillDirectory,
  substituteSkillDirectoryPlaceholders,
} from "@/node/services/agentSkills/skillDirectory";

/** Single-line skill description for the index, cut with an ellipsis past the cap. */
export function formatSkillIndexDescription(description: string): string {
  const singleLine = description.replace(/\s+/g, " ").trim();
  if (singleLine.length <= AGENT_SKILL_INDEX_DESCRIPTION_MAX_CHARS) {
    return singleLine;
  }
  let end = AGENT_SKILL_INDEX_DESCRIPTION_MAX_CHARS - 1;
  // A lone high surrogate would make providers reject every request carrying this tool block.
  const last = singleLine.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${singleLine.slice(0, end).trimEnd()}…`;
}

/**
 * Whether a skill belongs in the static index. Unadvertised skills (advertise: false or
 * disable-model-invocation: true, normalized into descriptor.advertise) stay out and can
 * still be invoked via /skill-name or agent_skill_read. Path-scoped skills (`paths`
 * frontmatter) stay out too: like Cursor and Claude Code, they surface only once a file
 * tool touches a matching file (pathSkillActivation.ts), and stay readable by name.
 */
function isIndexedSkill(skill: AgentSkillDescriptor): boolean {
  return skill.advertise !== false && skill.paths === undefined;
}

/**
 * Build dynamic agent_skill_read tool description with available skills.
 * Injects the list of available skills directly into the tool description
 * so the model sees them adjacent to the tool call schema.
 */
function buildSkillReadDescription(config: ToolConfiguration): string {
  const baseDescription = TOOL_DEFINITIONS.agent_skill_read.description;
  const skills = (config.availableSkills ?? []).filter(isIndexedSkill);

  if (skills.length === 0) {
    return baseDescription;
  }

  const MAX_SKILLS = 50;
  const shown = skills.slice(0, MAX_SKILLS);
  const omitted = skills.length - shown.length;

  const skillLines = shown.map((skill) => {
    const line = `- ${skill.name}: ${formatSkillIndexDescription(skill.description)} (scope: ${skill.scope})`;
    // whenToUse (when_to_use/when-to-use frontmatter) is extra model-facing guidance;
    // keep it on the same index line to stay token-lean.
    return skill.whenToUse == null ? line : `${line} When to use: ${skill.whenToUse}`;
  });
  if (omitted > 0) {
    skillLines.push(`(+${omitted} more not shown)`);
  }

  return `${baseDescription}\n\nAvailable skills:\n${skillLines.join("\n")}`;
}

/**
 * Skills that ship scripts locate themselves through skillDir (or the
 * ${CLAUDE_SKILL_DIR} placeholder) instead of a hard-coded install path.
 */
function buildSkillReadSuccess(
  resolved: ResolvedAgentSkill,
  workspaceRuntime: Runtime
): AgentSkillReadToolResult {
  const dir = resolveSkillDirectory(resolved, workspaceRuntime);
  const location = dir.available
    ? { skillDir: dir.skillDir, ...(dir.pluginRoot != null ? { pluginRoot: dir.pluginRoot } : {}) }
    : { skillDirUnavailable: dir.reason };
  return {
    success: true,
    skill: {
      ...resolved.package,
      body: substituteSkillDirectoryPlaceholders(resolved.package.body, dir),
    },
    ...location,
  };
}

/**
 * Agent Skill read tool factory.
 * Reads and validates a skill's SKILL.md from project-local or global skills roots.
 */
export const createAgentSkillReadTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: buildSkillReadDescription(config),
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
      // The schema regex cannot express the full plugin-name grammar.
      if (parseSkillLookupName(name) == null) {
        return {
          success: false,
          error: `Invalid skill name: ${name}`,
        };
      }

      try {
        // claude-skills-compat experiment: allow reading skills discovered from .claude roots.
        const includeClaudeSkills = config.experiments?.claudeSkillsCompat === true;
        const skillCtx = resolveSkillStorageContext({
          runtime: config.runtime,
          workspacePath,
          xumScope: config.xumScope ?? null,
          includeClaudeSkills,
        });
        const resolved = await readAgentSkill(skillCtx.runtime, skillCtx.workspacePath, name, {
          roots: skillCtx.roots,
          containment: skillCtx.containment,
          includeClaudeSkills,
        });
        // Judged against config.runtime: that is where the model's bash runs.
        return buildSkillReadSuccess(resolved, config.runtime);
      } catch (error) {
        return {
          success: false,
          error: getErrorMessage(error),
        };
      }
    },
  });
};
