/**
 * Xum does not add rules to the system prompt: every rule, an always-apply one included, loads as
 * a skill that the model reads on request. The rule type is in `metadata.cursor-rule-type`, so the
 * fingerprint changes, and asks for a new review, when a change to `alwaysApply` or `globs`
 * changes the type (D14).
 */
import YAML from "yaml";

import type { AgentPluginRuleType } from "@/common/orpc/schemas/agentPlugins";
import { MAX_SKILL_DESCRIPTION_LENGTH } from "@/common/orpc/schemas/agentSkill";
import {
  AgentSkillParseError,
  rewrittenSkillMarkdown,
} from "@/node/services/agentSkills/parseSkillMarkdown";
import {
  firstNonEmptyLine,
  normalizeNewlines,
  splitFrontmatter,
  stripUtf8Bom,
} from "@/node/utils/markdownFrontmatter";
import { skillDynamicDirectiveCommands } from "@/node/services/agentSkills/skillDynamicContext";
import assert from "@/common/utils/assert";
import { isPlainObject } from "./manifest";

export const CURSOR_RULE_EXTENSIONS = [".md", ".mdc", ".markdown"] as const;

export type CursorRuleType = AgentPluginRuleType;

export function cursorRuleName(file: string): string | undefined {
  const extension = CURSOR_RULE_EXTENSIONS.find((candidate) => file.endsWith(candidate));
  return extension === undefined ? undefined : file.slice(0, -extension.length);
}

function parseRuleFrontmatter(yaml: string): Record<string, unknown> | undefined {
  if (yaml.trim().length === 0) return {};
  try {
    const raw: unknown = YAML.parse(yaml);
    return isPlainObject(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

function ruleGlobs(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : [value];
  return entries
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.slice(0, MAX_SKILL_DESCRIPTION_LENGTH).trim())
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
 * Cut to the skill schema's cap, keeping the globs, so a long description never stops the rule
 * from loading.
 */
/**
 * The globs part of the description, built only up to the description cap: YAML aliases can repeat
 * one long glob many times, and joining them all would allocate far more than the cap keeps.
 */
function globsSuffix(globs: readonly string[]): string {
  if (globs.length === 0) return "";
  let suffix = "\n\nApplies to files matching: ";
  for (const [index, glob] of globs.entries()) {
    if (suffix.length >= MAX_SKILL_DESCRIPTION_LENGTH) break;
    suffix += `${index > 0 ? ", " : ""}${glob}`;
  }
  return suffix.slice(0, MAX_SKILL_DESCRIPTION_LENGTH);
}

function ruleSkillDescription(args: {
  name: string;
  description: string | undefined;
  body: string;
  globs: readonly string[];
}): string {
  const base = args.description ?? firstNonEmptyLine(args.body) ?? `Cursor rule ${args.name}`;
  const suffix = globsSuffix(args.globs);
  const room = Math.max(0, MAX_SKILL_DESCRIPTION_LENGTH - suffix.length);
  return `${base.slice(0, room)}${suffix}`.slice(0, MAX_SKILL_DESCRIPTION_LENGTH);
}

/**
 * A Cursor rule is guidance, and Cursor runs nothing in it. A line that skill dynamic context would
 * run as a shell command when the user invokes the skill (`!`cmd``, skillDynamicContext.ts) gets a
 * backslash in front, so it stays text: an unmanaged Cursor package has no review that shows it.
 */
function inertDirectiveLines(body: string): string {
  return body
    .split("\n")
    .map((line) => {
      if (skillDynamicDirectiveCommands(line).length === 0) return line;
      const escaped = `\\${line}`;
      assert(skillDynamicDirectiveCommands(escaped).length === 0, "escaped rule line still runs");
      return escaped;
    })
    .join("\n");
}

export interface CursorRuleRefusal {
  reason: string;
  warning: string;
}

/**
 * A rule whose text is over the SKILL.md cap once rewritten is refused: YAML aliases in `globs` or
 * `description` expand when the frontmatter is written again, and the scan sites parse the text
 * with the file's size.
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
    return {
      markdown: rewrittenSkillMarkdown(
        frontmatter,
        inertDirectiveLines(parts.body),
        `Rule '${rule.file}'`
      ),
    };
  } catch (error) {
    if (!(error instanceof AgentSkillParseError)) throw error;
    return { reason: "too large once rewritten as a skill", warning: error.message };
  }
}

export function cursorRuleSkillMarkdown(
  rule: { name: string; file: string },
  content: string
): string {
  const converted = convertCursorRule(rule, content);
  if ("warning" in converted) throw new AgentSkillParseError(converted.warning);
  return converted.markdown;
}
