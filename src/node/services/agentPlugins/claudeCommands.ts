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
 */
import YAML from "yaml";

import { SKILL_FILENAME } from "@/node/services/tools/skillFileUtils";
import { normalizeNewlines, stripUtf8Bom } from "@/node/utils/markdownFrontmatter";
import { isPlainObject } from "./manifest";

/** Longest description Xum takes from a command body's first line (the skill schema's cap). */
const MAX_DESCRIPTION_LENGTH = 1024;

/** The Markdown file of plugin skill `name` in its folder: SKILL.md, or `<name>.md` for a command. */
export function pluginSkillFileName(name: string, command: boolean | undefined): string {
  return command === true ? `${name}.md` : SKILL_FILENAME;
}

/** The SKILL.md text of a plugin skill file: a command gets its skill frontmatter (below). */
export function pluginSkillMarkdown(
  name: string,
  content: string,
  command: boolean | undefined
): string {
  return command === true ? claudeCommandSkillMarkdown(name, content) : content;
}

/** The frontmatter YAML text and the body of a Markdown file; no frontmatter: empty YAML. */
function splitFrontmatter(text: string): { yaml: string; body: string } | null {
  const lines = text.split("\n");
  if ((lines[0] ?? "").trim() !== "---") return { yaml: "", body: text };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  // An unclosed block: the parser reports it on the unchanged text.
  if (end === -1) return null;
  return { yaml: lines.slice(1, end).join("\n"), body: lines.slice(end + 1).join("\n") };
}

/** Claude's default description: the body's first non-empty line, cut to the schema's cap. */
function firstLineDescription(name: string, body: string): string {
  const line = body
    .split("\n")
    .map((text) => text.trim())
    .find((text) => text.length > 0);
  return (line ?? `Command /${name}`).slice(0, MAX_DESCRIPTION_LENGTH);
}

/**
 * The Claude Code docs write `argument-hint: [issue-number]` and `[filename] [format]` unquoted.
 * YAML reads the first as a list and refuses the second, so the command would not load, while
 * Claude Code shows the hint as typed. Quote a bracketed top-level hint so it stays that text.
 */
function quoteBracketedArgumentHint(yaml: string): string {
  return yaml.replace(
    /^argument-hint:[ \t]*(\[.*?)[ \t]*$/m,
    (_line, hint: string) => `argument-hint: ${JSON.stringify(hint)}`
  );
}

/**
 * A command file as SKILL.md text: its frontmatter with `name` set to the file name,
 * `disable-model-invocation: true` forced (a Claude command is for the user), and a description
 * taken from the first body line when it has none. Text whose frontmatter does not parse as a
 * mapping stays unchanged, so the skill parser reports the error.
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
        : firstLineDescription(name, parts.body),
    "disable-model-invocation": true,
  };
  return `---\n${YAML.stringify(frontmatter)}---\n${parts.body}`;
}
