import { SkillNameSchema } from "@/common/orpc/schemas/agentSkill";
import type {
  AgentSkillListResult,
  InvocableSkill,
  SkillLookupName,
  SkillName,
} from "@/common/types/agentSkill";
import { isValidAgentPluginName } from "@/common/utils/agentPluginName";
import assert from "@/common/utils/assert";

/**
 * Plugin skill namespaces: `<plugin>:<skill>` always resolves to that plugin's
 * skill, even when a higher-precedence skill owns the bare name. Plugin names
 * cannot contain `:` (AGENT_PLUGIN_NAME_PATTERN), so the first `:` splits.
 */
export interface ParsedSkillLookupName {
  /** Present only for a qualified lookup. */
  pluginName?: string;
  skillName: SkillName;
}

export function parseSkillLookupName(value: string): ParsedSkillLookupName | null {
  const separator = value.indexOf(":");
  if (separator === -1) {
    const bare = SkillNameSchema.safeParse(value);
    return bare.success ? { skillName: bare.data } : null;
  }

  const pluginName = value.slice(0, separator);
  const skill = SkillNameSchema.safeParse(value.slice(separator + 1));
  if (!isValidAgentPluginName(pluginName) || !skill.success) {
    return null;
  }
  return { pluginName, skillName: skill.data };
}

export function formatQualifiedSkillName(
  pluginName: string,
  skillName: SkillName
): SkillLookupName {
  return `${pluginName}:${skillName}`;
}

/**
 * Identity of a skill read: the qualified lookup name that was requested
 * (`input.name`, e.g. `pstack:tdd`) when it names the skill that was read, else
 * the frontmatter name. Otherwise a post-compaction re-read, the loaded-skill
 * list, or a remote slash/`$` fallback of the bare `tdd` could name a different
 * skill.
 */
export function resolveSkillReadIdentity(input: unknown, frontmatterName: string): string {
  if (typeof input !== "object" || input == null) return frontmatterName;
  const requested = (input as { name?: unknown }).name;
  if (typeof requested !== "string") return frontmatterName;
  const lookup = parseSkillLookupName(requested);
  return lookup?.pluginName != null && lookup.skillName === frontmatterName
    ? requested
    : frontmatterName;
}

/**
 * Skills offered on invocation surfaces: every winning skill under its bare name,
 * in its existing order, then each shadowed plugin skill under its qualified name.
 * Only shadowed plugin skills are listed qualified so menus and the index stay
 * uncluttered; a winning plugin skill is also reachable qualified.
 *
 * Qualified entries go last so bare names keep today's behavior: `/tdd` + Enter
 * must still pick the bare `tdd` (sorting `other:tdd` in first broke that in
 * UAT), and the model index keeps its existing entries ahead of its size cap.
 */
export function listInvocableSkills(
  result: Pick<AgentSkillListResult, "skills" | "shadowedPluginSkills">
): InvocableSkill[] {
  const shadowed = result.shadowedPluginSkills ?? [];
  if (shadowed.length === 0) {
    return result.skills;
  }

  const qualified = shadowed.map((skill): InvocableSkill => {
    assert(skill.pluginName != null, `Shadowed plugin skill '${skill.name}' has no pluginName`);
    return { ...skill, name: formatQualifiedSkillName(skill.pluginName, skill.name) };
  });
  qualified.sort((a, b) => a.name.localeCompare(b.name));
  return [...result.skills, ...qualified];
}
