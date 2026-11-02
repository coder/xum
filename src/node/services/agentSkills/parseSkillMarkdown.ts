import { AgentSkillFrontmatterSchema } from "@/common/orpc/schemas";
import type { AgentSkillFrontmatter, SkillName } from "@/common/types/agentSkill";
import { MAX_FILE_SIZE } from "@/node/services/tools/fileCommon";
import { formatZodIssues, normalizeNewlines, stripUtf8Bom } from "@/node/utils/markdownFrontmatter";
import YAML from "yaml";
import { getErrorMessage } from "@/common/utils/errors";
import { normalizeSkillPaths } from "@/common/utils/skills/skillPaths";

export class AgentSkillParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentSkillParseError";
  }
}

export interface ParsedSkillMarkdown {
  frontmatter: AgentSkillFrontmatter;
  body: string;
  /** Raw frontmatter `name` when allowDisplayName replaced it with the directory name. */
  displayName?: string;
}

function assertObject(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentSkillParseError(message);
  }
}

/**
 * Invalid `paths` globs make the whole skill invalid (surfaced through invalidSkills),
 * so descriptor builders can resolve `paths` without re-validating.
 */
function assertValidSkillPaths(frontmatter: AgentSkillFrontmatter): void {
  const result = normalizeSkillPaths(frontmatter.paths);
  if (!result.ok) {
    throw new AgentSkillParseError(`Invalid SKILL.md frontmatter: paths: ${result.error}`);
  }
}

// A display name is a single line of 1-64 characters. SKILL.md is repository-controlled
// and the name renders in the UI and in diagnostics, so reject every control (C0, DEL,
// C1), format (bidi overrides, zero-width) and line/paragraph separator character.
const DISPLAY_NAME_MAX_LENGTH = 64;
const CONTROL_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function qualifyDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > DISPLAY_NAME_MAX_LENGTH) return undefined;
  if (CONTROL_CHARACTER_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Swap a qualifying non-ID `name` for the directory name (see allowDisplayName).
 * `displayField` is spread into the result, so the key is absent when unused.
 */
function applyDisplayName(
  raw: Record<string, unknown>,
  input: { directoryName?: SkillName; allowDisplayName?: boolean }
): { frontmatterInput: Record<string, unknown>; displayField: { displayName?: string } } {
  const unchanged = { frontmatterInput: raw, displayField: {} };
  if (!input.allowDisplayName || !input.directoryName || raw.name === input.directoryName) {
    return unchanged;
  }
  const displayName = qualifyDisplayName(raw.name);
  if (displayName === undefined) return unchanged;
  return {
    frontmatterInput: { ...raw, name: input.directoryName },
    displayField: { displayName },
  };
}

/**
 * The frontmatter that plugin skill consent fingerprints (#6498). allowDisplayName moved the raw
 * `name` out of `frontmatter`, so add it back as `displayName`: a changed display name is
 * user-visible text and needs a new review. Skills without a display name keep their fingerprint.
 */
export function skillConsentFrontmatter(
  parsed: ParsedSkillMarkdown
): AgentSkillFrontmatter & { displayName?: string } {
  return parsed.displayName === undefined
    ? parsed.frontmatter
    : { ...parsed.frontmatter, displayName: parsed.displayName };
}

/**
 * Parse a SKILL.md file into validated frontmatter + markdown body.
 *
 * Defensive constraints:
 * - Enforces a 1MB max file size (consistent with existing file tools)
 * - Requires YAML frontmatter delimited by `---` on its own line at the top
 */
/**
 * The Claude Code docs write `argument-hint: [issue-number]` and `[filename] [format]` unquoted.
 * YAML reads the first as a list and refuses the second, so the skill did not load (#7123 item 5),
 * while Claude Code shows the hint as typed. Quote a bracketed top-level hint so it stays that
 * text. JSON.stringify keeps a hint with quotes or backslashes valid YAML; an already quoted value
 * does not start with `[`, so it is left alone. Claude command files (claudeCommands.ts) use it
 * too, before their frontmatter is rewritten into SKILL.md text.
 */
export function quoteBracketedArgumentHint(yaml: string): string {
  // Top-level keys share the indent of the first content line (YAML allows an indented root
  // mapping). Deeper lines, such as block scalar text, are left alone.
  const rootIndent = /^([ \t]*)[^\s#]/m.exec(yaml)?.[1] ?? "";
  // Keep the pattern free of nested or adjacent variable-length groups: SKILL.md can be 1 MB from
  // a cloned repo, and a lazy hint followed by an optional comment group backtracked in O(n^2).
  const hintLine = new RegExp(`^(${rootIndent}argument-hint[ \\t]*:)[ \\t]*(\\[.*)$`, "m");
  return yaml.replace(hintLine, (_line, key: string, rest: string) => {
    // A `#` after whitespace starts a YAML comment: it stays a comment, outside the quoted hint.
    const commentStart = rest.search(/[ \t]#/);
    const hint = (commentStart === -1 ? rest : rest.slice(0, commentStart)).trimEnd();
    const comment = commentStart === -1 ? "" : rest.slice(commentStart);
    return `${key} ${JSON.stringify(hint)}${comment}`;
  });
}

/**
 * SKILL.md text written from a frontmatter object and a body, for plugin files that Xum reads as
 * skills (Claude commands, Cursor rules). YAML aliases can repeat one large value many times, so
 * the text can be far bigger than the file, and every caller parses it with the file's byteSize:
 * over the SKILL.md cap it throws AgentSkillParseError, naming the file as `label`.
 */
export function rewrittenSkillMarkdown(
  frontmatter: Record<string, unknown>,
  body: string,
  label: string
): string {
  const rewritten = `---\n${YAML.stringify(frontmatter)}---\n${body}`;
  if (Buffer.byteLength(rewritten, "utf8") > MAX_FILE_SIZE) {
    throw new AgentSkillParseError(
      `${label} is larger than ${MAX_FILE_SIZE} bytes once its frontmatter is rewritten as a skill; it does not load.`
    );
  }
  return rewritten;
}

export function parseSkillMarkdown(input: {
  content: string;
  byteSize: number;
  directoryName?: SkillName;
  /**
   * Discovered skills only (project, global, plugin roots): when the frontmatter `name`
   * differs from the directory name, load the skill under the directory name and return
   * the raw `name` as `displayName`. Skills from other harnesses need this, e.g. pstack's
   * `name: Poteto Mode`; Cursor and Claude Code take the skill ID from the folder.
   * Built-in skills and agent_skill_write stay strict.
   */
  allowDisplayName?: boolean;
}): ParsedSkillMarkdown {
  if (input.byteSize > MAX_FILE_SIZE) {
    const sizeMB = (input.byteSize / (1024 * 1024)).toFixed(2);
    const maxMB = (MAX_FILE_SIZE / (1024 * 1024)).toFixed(2);
    throw new AgentSkillParseError(
      `SKILL.md is too large (${sizeMB}MB). Maximum supported size is ${maxMB}MB.`
    );
  }

  const content = normalizeNewlines(stripUtf8Bom(input.content));

  // Frontmatter must start at byte 0.
  if (!content.startsWith("---")) {
    throw new AgentSkillParseError("SKILL.md must start with YAML frontmatter delimited by '---'.");
  }

  const lines = content.split("\n");
  if ((lines[0] ?? "").trim() !== "---") {
    throw new AgentSkillParseError("SKILL.md frontmatter start delimiter must be exactly '---'.");
  }

  const endIndex = lines.findIndex((line, idx) => idx > 0 && line.trim() === "---");
  if (endIndex === -1) {
    throw new AgentSkillParseError("SKILL.md frontmatter is missing the closing '---' delimiter.");
  }

  const yamlText = lines.slice(1, endIndex).join("\n");
  const body = lines.slice(endIndex + 1).join("\n");

  let raw: unknown;
  try {
    raw = YAML.parse(quoteBracketedArgumentHint(yamlText));
  } catch (err) {
    const message = getErrorMessage(err);
    throw new AgentSkillParseError(`Failed to parse SKILL.md YAML frontmatter: ${message}`);
  }

  assertObject(raw, "SKILL.md YAML frontmatter must be a mapping/object.");

  const { frontmatterInput, displayField } = applyDisplayName(raw, input);
  const parsed = AgentSkillFrontmatterSchema.safeParse(frontmatterInput);
  if (!parsed.success) {
    throw new AgentSkillParseError(
      `Invalid SKILL.md frontmatter: ${formatZodIssues(parsed.error.issues)}`
    );
  }

  assertValidSkillPaths(parsed.data);

  if (input.directoryName && parsed.data.name !== input.directoryName) {
    throw new AgentSkillParseError(
      `SKILL.md frontmatter.name '${parsed.data.name}' must match directory name '${input.directoryName}'.`
    );
  }

  return { frontmatter: parsed.data, body, ...displayField };
}
