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

const BRACKET_DEPTH_DELTA: Record<string, number> = {
  "{": 1,
  "[": 1,
  "(": 1,
  "}": -1,
  "]": -1,
  ")": -1,
};

/**
 * Split a comma-separated `paths` string. Commas inside `{}`/`[]`/`()` belong to the
 * glob (`*.{ts,tsx}`), so only top-level commas separate patterns.
 */
function splitTopLevelCommas(value: string): string[] {
  const parts = [""];
  let depth = 0;
  for (const char of value) {
    if (char === "," && depth === 0) {
      parts.push("");
      continue;
    }
    depth = Math.max(0, depth + (BRACKET_DEPTH_DELTA[char] ?? 0));
    parts[parts.length - 1] += char;
  }
  return parts;
}

function validateSkillPathPattern(pattern: string): string | undefined {
  if (pattern.length === 0) {
    return "patterns must not be empty";
  }
  if (pattern.length > MAX_SKILL_PATH_LENGTH) {
    return `pattern '${pattern.slice(0, 40)}…' is longer than ${MAX_SKILL_PATH_LENGTH} characters`;
  }
  if (/^[/\\]/.test(pattern) || /^[A-Za-z]:/.test(pattern)) {
    return `pattern '${pattern}' must be relative to the workspace root, not absolute`;
  }
  // Patterns are OR-ed (any match activates the skill), so a negated glob would
  // match every other file and make the skill global. Reject it instead.
  if (pattern.startsWith("!")) {
    return `pattern '${pattern}' must not be negated (patterns are combined with OR)`;
  }
  if (pattern.split(/[/\\]/).includes("..")) {
    return `pattern '${pattern}' must not contain '..' segments`;
  }
  try {
    picomatch(pattern, PICOMATCH_OPTIONS);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `pattern '${pattern}' is not a valid glob: ${reason}`;
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

  const entries = (typeof raw === "string" ? splitTopLevelCommas(raw) : raw).map((entry) =>
    // A leading "./" is a common way to spell "relative to the root"; matching sees
    // paths without it.
    entry.trim().replace(/^(\.\/)+/, "")
  );
  if (entries.length === 0) {
    return { ok: false, error: "at least one pattern is required" };
  }
  if (entries.length > MAX_SKILL_PATHS) {
    return { ok: false, error: `at most ${MAX_SKILL_PATHS} patterns are allowed` };
  }

  for (const entry of entries) {
    const error = validateSkillPathPattern(entry);
    if (error !== undefined) {
      return { ok: false, error };
    }
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

const matcherCache = new Map<string, (input: string) => boolean>();

/** True when a workspace-root-relative POSIX path matches any of the skill's globs. */
export function matchesSkillPaths(paths: readonly string[], relativePosixPath: string): boolean {
  return paths.some((pattern) => {
    let matcher = matcherCache.get(pattern);
    if (matcher === undefined) {
      matcher = picomatch(pattern, PICOMATCH_OPTIONS);
      matcherCache.set(pattern, matcher);
    }
    return matcher(relativePosixPath);
  });
}
