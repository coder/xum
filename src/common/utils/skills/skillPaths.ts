import picomatch from "picomatch";

import assert from "@/common/utils/assert";

/**
 * `paths:` SKILL.md frontmatter (Cursor / Claude Code key): globs relative to the
 * workspace root. A path-scoped skill surfaces to the model only after a file tool
 * touches a matching file (see pathSkillActivation.ts).
 *
 * Kept out of src/common/orpc/schemas so the browser bundle never pulls picomatch;
 * only node-side descriptor builders call these helpers.
 */

const MAX_SKILL_PATHS = 50;
const MAX_SKILL_PATH_LENGTH = 512;

// windows: false - tool paths are normalized to POSIX before matching, so matching
// must not depend on the host OS. strictBrackets turns an unclosed `[`, `{` or `(`
// into a compile error instead of a silent literal match.
const PICOMATCH_OPTIONS = { dot: true, strictBrackets: true, windows: false } as const;

export type NormalizeSkillPathsResult =
  | { ok: true; paths: string[] | undefined }
  | { ok: false; error: string };

/**
 * The comma-separated string form supports plain globs and `{a,b}` alternation only.
 * A comma inside a `[...]` class or an `@(...)` extglob is ambiguous with the pattern
 * separator, so those patterns must use the list form (rejected up front, never split
 * silently).
 */
function splitCommaString(value: string): string[] | { error: string } {
  if (/[[(]/.test(value)) {
    return {
      error: "the comma-separated form does not support '[' or '(' in patterns; use the list form",
    };
  }
  const parts = [""];
  let braceDepth = 0;
  for (const char of value) {
    if (char === "," && braceDepth === 0) {
      parts.push("");
      continue;
    }
    if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
    parts[parts.length - 1] += char;
  }
  return parts.map((part) => part.trim());
}

/**
 * Shape rules, checked in order: the pattern must be a non-empty, bounded,
 * workspace-relative include glob. Each rule returns its error, or undefined.
 */
const SKILL_PATH_SHAPE_RULES: ReadonlyArray<(pattern: string) => string | undefined> = [
  (p) => (p.length === 0 ? "patterns must not be empty" : undefined),
  (p) =>
    p.length > MAX_SKILL_PATH_LENGTH
      ? `pattern '${p.slice(0, 40)}…' is longer than ${MAX_SKILL_PATH_LENGTH} characters`
      : undefined,
  // A backslash cannot be both a glob escape and a Windows separator, so patterns use
  // '/' only (match a literal '[' with '[[]').
  (p) =>
    p.includes("\\")
      ? `pattern '${p}' must use '/' as the path separator (backslashes are not supported)`
      : undefined,
  (p) =>
    p.startsWith("/") || /^[A-Za-z]:\//.test(p)
      ? `pattern '${p}' must be relative to the workspace root, not absolute`
      : undefined,
  // Patterns are OR-ed (any match activates the skill), so a negated glob would
  // match every other file and make the skill global. Reject it instead.
  // `!(...)` is a negative extglob (an include pattern), not whole-pattern negation.
  (p) =>
    p.startsWith("!") && !p.startsWith("!(")
      ? `pattern '${p}' must not be negated (patterns are combined with OR)`
      : undefined,
  // Tool paths are normalized, so a '.' or '..' segment could never match.
  (p) =>
    p.split("/").some((segment) => segment === "." || segment === "..")
      ? `pattern '${p}' must not contain '.' or '..' segments`
      : undefined,
];

function validateSkillPathShape(pattern: string): string | undefined {
  for (const rule of SKILL_PATH_SHAPE_RULES) {
    const error = rule(pattern);
    if (error !== undefined) return error;
  }
  return undefined;
}

function validateSkillPathPattern(pattern: string): string | undefined {
  const shapeError = validateSkillPathShape(pattern);
  if (shapeError !== undefined) {
    return shapeError;
  }
  try {
    picomatch(pattern, PICOMATCH_OPTIONS);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `pattern '${pattern}' is not a valid glob: ${reason}`;
  }
  return undefined;
}

function firstPatternError(entries: readonly string[]): string | undefined {
  for (const entry of entries) {
    const error = validateSkillPathPattern(entry);
    if (error !== undefined) return error;
  }
  return undefined;
}

/**
 * Normalize raw `paths` frontmatter (comma-separated string or list) into a deduped
 * pattern list, or an error naming the bad pattern. `undefined` means "not path-scoped".
 */
export function normalizeSkillPaths(raw: string | string[] | undefined): NormalizeSkillPathsResult {
  if (raw === undefined) {
    return { ok: true, paths: undefined };
  }

  // List entries are taken as written (whitespace is valid in file names); only the
  // fragments of a comma-separated string are trimmed.
  const split = typeof raw === "string" ? splitCommaString(raw) : raw;
  if (!Array.isArray(split)) {
    return { ok: false, error: split.error };
  }
  const entries = split.map((entry) =>
    // A leading "./" is a common way to spell "relative to the root"; matching sees
    // paths without it.
    entry.replace(/^(\.\/)+/, "")
  );
  if (entries.length === 0) {
    return { ok: false, error: "at least one pattern is required" };
  }
  if (entries.length > MAX_SKILL_PATHS) {
    return { ok: false, error: `at most ${MAX_SKILL_PATHS} patterns are allowed` };
  }

  const error = firstPatternError(entries);
  if (error !== undefined) {
    return { ok: false, error };
  }

  return { ok: true, paths: [...new Set(entries)] };
}

/**
 * Normalized `paths` for a descriptor. parseSkillMarkdown already rejects invalid
 * `paths`, so a failure here means a caller skipped the parser.
 */
export function resolveSkillPaths(frontmatter: {
  paths?: string | string[];
}): string[] | undefined {
  const result = normalizeSkillPaths(frontmatter.paths);
  assert(result.ok, "resolveSkillPaths: frontmatter must come from parseSkillMarkdown");
  return result.paths;
}

/**
 * One matcher for a skill's globs: true when a workspace-root-relative POSIX path
 * matches any of them. There is no process-wide cache: callers that match often
 * (pathSkillActivation) keep the matcher for the turn, so untrusted repositories
 * cannot grow memory across turns.
 */
export function createSkillPathsMatcher(paths: readonly string[]): (path: string) => boolean {
  return picomatch([...paths], PICOMATCH_OPTIONS);
}

/** True when a workspace-root-relative POSIX path matches any of the skill's globs. */
export function matchesSkillPaths(paths: readonly string[], relativePosixPath: string): boolean {
  return createSkillPathsMatcher(paths)(relativePosixPath);
}
