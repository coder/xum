/**
 * Claude Code plugin commands (`commands/<name>.md`) as plugin skills.
 *
 * Source: https://code.claude.com/docs/en/plugins-reference.md. A command is a flat Markdown
 * file whose optional frontmatter (description, argument-hint, ...) and body work like a skill's.
 * Xum loads each one as the plugin skill `<name>` that only the user invokes (`/name`):
 * `disable-model-invocation: true` is forced, so the model never sees it in its skill index. The
 * scan sites read `<name>.md` instead of SKILL.md (PluginSkillsRoot `command`) and turn it into
 * SKILL.md text here, before the regular parser runs. Everything after that (the consent
 * fingerprint of the parsed frontmatter, approved copies, `$ARGUMENTS`) is the skill path.
 * A Cursor rule (PluginSkillsRoot `rule`) takes the same path through cursorRules.ts.
 */
import YAML from "yaml";

import {
  MAX_SKILL_DESCRIPTION_LENGTH,
  quoteBracketedArgumentHint,
  rewrittenSkillMarkdown,
} from "@/node/services/agentSkills/parseSkillMarkdown";
import { SKILL_FILENAME } from "@/node/services/tools/skillFileUtils";
import {
  firstNonEmptyLine,
  normalizeNewlines,
  splitFrontmatter,
  stripUtf8Bom,
} from "@/node/utils/markdownFrontmatter";
import { cursorRuleSkillMarkdown } from "./cursorRules";
import { isPlainObject } from "./manifest";

/** Which file a plugin skill is: SKILL.md, a Claude command, or a Cursor rule (never both). */
export interface PluginSkillFileKind {
  command?: true | undefined;
  /** The rule's file name in its folder, for example `prefer-const.mdc`. */
  rule?: string | undefined;
}

/** The Markdown file of plugin skill `name` in its folder: SKILL.md, `<name>.md` or the rule file. */
export function pluginSkillFileName(name: string, root: PluginSkillFileKind): string {
  if (root.rule !== undefined) return root.rule;
  return root.command === true ? `${name}.md` : SKILL_FILENAME;
}

/** The SKILL.md text of a plugin skill file: a command or a rule gets its skill frontmatter. */
export function pluginSkillMarkdown(
  name: string,
  content: string,
  root: PluginSkillFileKind
): string {
  if (root.rule !== undefined) return cursorRuleSkillMarkdown({ name, file: root.rule }, content);
  return root.command === true ? claudeCommandSkillMarkdown(name, content) : content;
}

/**
 * A command file as SKILL.md text: its frontmatter with `name` set to the file name,
 * `disable-model-invocation: true` forced (a Claude command is for the user), and a description
 * taken from the first body line when it has none. Text whose frontmatter does not parse as a
 * mapping stays unchanged, so the skill parser reports the error. Throws AgentSkillParseError
 * when the rewritten text is over the SKILL.md size cap.
 */
export function claudeCommandSkillMarkdown(name: string, content: string): string {
  const parts = splitFrontmatter(normalizeNewlines(stripUtf8Bom(content)));
  if (parts === null) return content;
  let raw: unknown;
  try {
    raw = parts.yaml.trim().length === 0 ? {} : YAML.parse(quoteBracketedArgumentHint(parts.yaml));
  } catch {
    return content;
  }
  if (!isPlainObject(raw)) return content;
  const { description } = raw;
  const frontmatter = {
    ...raw,
    name,
    description:
      typeof description === "string" && description.trim().length > 0
        ? description
        : (firstNonEmptyLine(parts.body) ?? `Command /${name}`).slice(
            0,
            MAX_SKILL_DESCRIPTION_LENGTH
          ),
    "disable-model-invocation": true,
  };
  return rewrittenSkillMarkdown(frontmatter, parts.body, `Command /${name}`);
}
