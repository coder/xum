import { PLUGIN_SIBLING_NOTE_MAX_SKILLS } from "@/common/constants/toolLimits";
import type { InvocableSkill, SkillName } from "@/common/types/agentSkill";
import { parseSkillLookupName } from "@/common/utils/agentSkills/skillLookupName";
import assert from "@/common/utils/assert";

/**
 * Plugin skills refer to sibling skills by bare name (pstack's poteto-mode says
 * "See the **tdd** skill"). A bare name resolves by scope precedence and plugin
 * skills come last, so a user's own `tdd` would win. Resolution stays unchanged;
 * instead, when Xum returns a plugin skill to the model, this note maps each
 * sibling of the SAME plugin whose bare name is shadowed to its qualified name.
 *
 * `skills` is the invocable list (listInvocableSkills): shadowed plugin skills
 * appear there under `<plugin>:<skill>`, so qualified entries of this plugin are
 * exactly its shadowed siblings. Returns null when there are none.
 */
export function formatPluginSiblingNote(args: {
  pluginName: string;
  skillName: SkillName;
  skills: readonly InvocableSkill[];
}): string | null {
  assert(args.pluginName.length > 0, "formatPluginSiblingNote: pluginName is required");

  const siblings: string[] = [];
  for (const skill of args.skills) {
    const lookup = parseSkillLookupName(skill.name);
    // Only qualified entries of this plugin (never another plugin's); a bare
    // entry won its name, so the bare reference already reaches it.
    if (lookup?.pluginName !== args.pluginName) continue;
    if (lookup.skillName === args.skillName) continue;
    siblings.push(lookup.skillName);
  }
  if (siblings.length === 0) return null;

  const shown = siblings.slice(0, PLUGIN_SIBLING_NOTE_MAX_SKILLS);
  const mappings = shown.map((name) => `\`${name}\` -> \`${args.pluginName}:${name}\``);
  const omitted = siblings.length - shown.length;
  const overflow =
    omitted > 0
      ? `, and ${omitted} more: read any other skill of this plugin as \`${args.pluginName}:<name>\``
      : "";
  return (
    `Plugin \`${args.pluginName}\`: other skills use some of this plugin's skill names. ` +
    `When this skill refers to one of these skills, read the plugin's own skill by its qualified name: ` +
    `${mappings.join(", ")}${overflow}.`
  );
}

/**
 * First, not last: snapshot bodies are cut at MAX_AGENT_SKILL_SNAPSHOT_CHARS (same
 * reason as prependSkillDirectoryOffHostNote). The note lives in the body, not a
 * side field, so post-compaction re-injection of the snapshot body keeps it.
 */
export function prependPluginSiblingNote(body: string, note: string | null): string {
  return note == null ? body : `${note}\n\n${body}`;
}
