/**
 * Cursor plugin rules (`rules/<name>.mdc`, `.md`, `.markdown`) as plugin skills (Cursor plugin
 * RFC section 2).
 *
 * Xum does not add rules to the system prompt: every rule, an always-apply one included, loads as
 * a skill that the model reads on request. The scan sites read the rule file instead of SKILL.md
 * (PluginSkillsRoot `rule`) and turn it into SKILL.md text here, the way claudeCommands.ts turns
 * a Claude command into a skill. Everything after that (the consent fingerprint of the converted
 * frontmatter, approved copies) is the skill path. The rule type is in
 * `metadata.cursor-rule-type`, so the fingerprint changes, and asks for a new review, when a
 * change to `alwaysApply` or `globs` changes the type (D14).
 */
import YAML from "yaml";

import {
  AgentSkillParseError,
  MAX_SKILL_DESCRIPTION_LENGTH,
  rewrittenSkillMarkdown,
} from "@/node/services/agentSkills/parseSkillMarkdown";
import {
  firstNonEmptyLine,
  normalizeNewlines,
  splitFrontmatter,
  stripUtf8Bom,
} from "@/node/utils/markdownFrontmatter";
import { isPlainObject } from "./manifest";

export const CURSOR_RULE_EXTENSIONS = [".md", ".mdc", ".markdown"] as const;

/** Precedence: `alwaysApply: true` wins over `globs`, and `globs` over `description` only. */
export type CursorRuleType = "always-apply" | "description" | "glob" | "manual";

/** The rule name of a file (the file name without its extension), or undefined for another file. */
export function cursorRuleName(file: string): string | undefined {
  const extension = CURSOR_RULE_EXTENSIONS.find((candidate) => file.endsWith(candidate));
  return extension === undefined ? undefined : file.slice(0, -extension.length);
}

/** The frontmatter mapping of a rule, or undefined when it does not parse as one. */
function parseRuleFrontmatter(yaml: string): Record<string, unknown> | undefined {
  if (yaml.trim().length === 0) return {};
  try {
    const raw: unknown = YAML.parse(yaml);
    return isPlainObject(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Cursor `globs`: one pattern or a list of them. Empty values do not count. */
function ruleGlobs(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : [value];
  return entries
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function cursorRuleType(
  frontmatter: Record<string, unknown>,
  globs: readonly string[]
): CursorRuleType {
  if (frontmatter.alwaysApply === true) return "always-apply";
  if (globs.length > 0) return "glob";
  return nonEmptyString(frontmatter.description) !== undefined ? "description" : "manual";
}

/**
 * The skill description: the rule's `description`, else its first body line, else a name-based
 * one, with the globs appended. It is cut to the skill schema's cap, keeping the globs, so a long
 * description never stops the rule from loading.
 */
function ruleSkillDescription(args: {
  name: string;
  description: string | undefined;
  body: string;
  globs: readonly string[];
}): string {
  const base = args.description ?? firstNonEmptyLine(args.body) ?? `Cursor rule ${args.name}`;
  const suffix =
    args.globs.length > 0 ? `\n\nApplies to files matching: ${args.globs.join(", ")}` : "";
  const room = Math.max(0, MAX_SKILL_DESCRIPTION_LENGTH - suffix.length);
  return `${base.slice(0, room)}${suffix}`.slice(0, MAX_SKILL_DESCRIPTION_LENGTH);
}

/** Why a rule file does not load as a skill: the `notApplied` reason and the warning. */
export interface CursorRuleRefusal {
  reason: string;
  warning: string;
}

/**
 * A rule file as SKILL.md text, or why it does not load. The frontmatter is written from scratch
 * (name, description, the user-only flag for a manual rule, the rule type), and the body stays
 * unchanged. A rule whose frontmatter does not parse as a mapping is refused. So is one whose
 * text is over the SKILL.md cap once rewritten: YAML aliases in `globs` or `description` expand
 * when the frontmatter is written again, and the scan sites parse the text with the file's size.
 */
export function convertCursorRule(
  rule: { name: string; file: string },
  content: string
): { markdown: string } | CursorRuleRefusal {
  const parts = splitFrontmatter(normalizeNewlines(stripUtf8Bom(content)));
  const raw = parts === null ? undefined : parseRuleFrontmatter(parts.yaml);
  if (parts === null || raw === undefined) {
    return {
      reason: "invalid frontmatter",
      warning: `Rule '${rule.file}' has invalid frontmatter; ignoring it`,
    };
  }
  const globs = ruleGlobs(raw.globs);
  const type = cursorRuleType(raw, globs);
  const frontmatter = {
    name: rule.name,
    description: ruleSkillDescription({
      name: rule.name,
      description: nonEmptyString(raw.description),
      body: parts.body,
      globs,
    }),
    ...(type === "manual" ? { "disable-model-invocation": true } : {}),
    metadata: { "cursor-rule-type": type },
  };
  try {
    return { markdown: rewrittenSkillMarkdown(frontmatter, parts.body, `Rule '${rule.file}'`) };
  } catch (error) {
    if (!(error instanceof AgentSkillParseError)) throw error;
    return { reason: "too large once rewritten as a skill", warning: error.message };
  }
}

/** convertCursorRule for the scan sites: a refused rule throws AgentSkillParseError. */
export function cursorRuleSkillMarkdown(
  rule: { name: string; file: string },
  content: string
): string {
  const converted = convertCursorRule(rule, content);
  if ("warning" in converted) throw new AgentSkillParseError(converted.warning);
  return converted.markdown;
}
