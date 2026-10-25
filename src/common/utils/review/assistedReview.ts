/**
 * Helpers for the agent-driven "Assisted review" feature.
 *
 * The `review_pane_update` tool lets an agent flag specific code regions for
 * user review. Each filter is a string like:
 *
 *   src/foo/bar.ts            // whole file
 *   src/foo/bar.ts:42         // single line
 *   src/foo/bar.ts:42-58      // inclusive line range (new-file numbering)
 *
 * This module parses those strings, normalizes them into {@link AssistedReviewHunk},
 * and matches them against concrete {@link DiffHunk}s loaded in the review pane.
 *
 * Matching is intentionally simple and forgiving: paths must match exactly
 * (project-relative); ranges are tested for overlap on the new-side line
 * numbers. Whole-file filters match every hunk for that path.
 */

import type { AssistedReviewHunk, DiffHunk } from "@/common/types/review";

/** Maximum number of assisted hunks an agent may set in a single update. */
export const ASSISTED_REVIEW_MAX_HUNKS = 100;

export interface ParsedAssistedFilter {
  path: string;
  range?: { start: number; end: number };
}

export interface ProjectRelativePathContext {
  /** Absolute project root path from workspace metadata. */
  projectPath?: string | null;
  /**
   * Absolute tool execution root. Tool input paths may be relative to this cwd,
   * but persisted Review pins are normalized to `projectPath` coordinates.
   */
  executionRootPath?: string | null;
}

function normalizePathSeparators(value: string | null | undefined): string {
  return value?.replaceAll("\\", "/").trim() ?? "";
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isAbsoluteLikePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:\//.test(value);
}

function normalizePathSegments(pathValue: string): string {
  const normalized = normalizePathSeparators(pathValue);
  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      const previous = segments.at(-1);
      if (previous && previous !== "..") {
        segments.pop();
      } else {
        segments.push(segment);
      }
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

/**
 * Compute a host path relative to the project root using normalized separators.
 * This intentionally avoids Node's `path.relative` so browser and backend code
 * agree even when host paths use Windows separators.
 */
export function deriveProjectRelativePath(
  projectPath: string | null | undefined,
  targetPath: string | null | undefined
): string | null {
  const project = stripTrailingSlash(normalizePathSeparators(projectPath));
  const target = stripTrailingSlash(normalizePathSeparators(targetPath));
  if (!project || !target || project === target) return null;
  if (!target.startsWith(`${project}/`)) return null;
  return normalizePathSegments(target.slice(project.length + 1));
}

export interface ProjectRelativePathCandidates {
  /** The canonical project-relative path to persist/display for this input. */
  primaryPath: string;
  /** Fallback project-relative paths to try when the primary path has no matching hunk. */
  fallbackPaths: string[];
  /** Primary plus fallbacks, deduped in lookup order. */
  candidatePaths: string[];
}

export interface AssistedReviewPathCandidate {
  /** Candidate path to compare exactly against a diff hunk path. */
  path: string;
  /** Original assisted entry that owns comments/ranges/ordering metadata. */
  entry: AssistedReviewHunk;
  /** Index of the original assisted entry, not the candidate expansion index. */
  index: number;
}

function isExplicitExecutionRelativePath(rawPath: string): boolean {
  return (
    rawPath === "." || rawPath === ".." || rawPath.startsWith("./") || rawPath.startsWith("../")
  );
}

function resolveToolPathFromExecutionRoot(
  normalizedPath: string,
  executionRootRelativePath: string
): string {
  return normalizePathSegments(`${executionRootRelativePath}/${normalizedPath}`);
}

function firstPathSegment(pathValue: string): string {
  return pathValue.split("/", 1)[0] ?? "";
}

function dedupePaths(paths: readonly string[]): string[] {
  return Array.from(new Set(paths.filter((pathValue) => pathValue.length > 0)));
}

/**
 * Resolve an agent-supplied path into ordered project-relative candidates.
 *
 * Review's canonical coordinate system is project-relative. Plain paths are
 * therefore treated as project-relative first, with an execution-root-relative
 * fallback so accepted `src/foo.ts` pins from scoped workspaces still match
 * `packages/api/src/foo.ts`. Explicit `./` or `../` input is unambiguous and
 * resolves directly from the tool cwd.
 */
export function getToolPathProjectRelativeCandidates(
  toolPath: string,
  context?: ProjectRelativePathContext
): ProjectRelativePathCandidates {
  const rawPath = normalizePathSeparators(toolPath);
  if (isAbsoluteLikePath(rawPath)) {
    return { primaryPath: rawPath, fallbackPaths: [], candidatePaths: rawPath ? [rawPath] : [] };
  }

  const normalizedPath = normalizePathSegments(rawPath);
  const executionRootRelativePath = deriveProjectRelativePath(
    context?.projectPath,
    context?.executionRootPath
  );
  if (!normalizedPath || !executionRootRelativePath) {
    const candidatePaths = normalizedPath ? [normalizedPath] : [];
    return { primaryPath: normalizedPath, fallbackPaths: [], candidatePaths };
  }

  if (isExplicitExecutionRelativePath(rawPath)) {
    const primaryPath = resolveToolPathFromExecutionRoot(normalizedPath, executionRootRelativePath);
    return { primaryPath, fallbackPaths: [], candidatePaths: primaryPath ? [primaryPath] : [] };
  }

  if (
    normalizedPath === executionRootRelativePath ||
    normalizedPath.startsWith(`${executionRootRelativePath}/`)
  ) {
    return { primaryPath: normalizedPath, fallbackPaths: [], candidatePaths: [normalizedPath] };
  }

  // Prefer the project-relative contract for root files (`README.md`) and
  // obvious sibling project paths (`packages/shared/x.ts` next to
  // `packages/api`). Agents can use `./` when they need to force cwd-relative
  // resolution for these otherwise-ambiguous shapes.
  if (
    !normalizedPath.includes("/") ||
    firstPathSegment(normalizedPath) === firstPathSegment(executionRootRelativePath)
  ) {
    return { primaryPath: normalizedPath, fallbackPaths: [], candidatePaths: [normalizedPath] };
  }

  const fallbackPaths = dedupePaths([
    resolveToolPathFromExecutionRoot(normalizedPath, executionRootRelativePath),
  ]).filter((pathValue) => pathValue !== normalizedPath);
  return {
    primaryPath: normalizedPath,
    fallbackPaths,
    candidatePaths: dedupePaths([normalizedPath, ...fallbackPaths]),
  };
}

/**
 * Normalize an agent-supplied path into the primary project-relative path used
 * for persistence/display. Use {@link getToolPathProjectRelativeCandidates}
 * when matching or fetching diffs so ambiguous cwd-relative inputs can still
 * fall back to the current execution root without corrupting canonical paths.
 */
export function normalizeToolPathToProjectRelative(
  toolPath: string,
  context?: ProjectRelativePathContext
): string {
  return getToolPathProjectRelativeCandidates(toolPath, context).primaryPath;
}

export function normalizeAssistedReviewHunk(
  hunk: AssistedReviewHunk,
  context?: ProjectRelativePathContext
): AssistedReviewHunk {
  const normalizedPath = normalizeToolPathToProjectRelative(hunk.path, context);
  return normalizedPath === hunk.path ? hunk : { ...hunk, path: normalizedPath };
}

export function normalizeAssistedReviewHunks(
  hunks: readonly AssistedReviewHunk[],
  context?: ProjectRelativePathContext
): AssistedReviewHunk[] {
  return hunks.map((hunk) => normalizeAssistedReviewHunk(hunk, context));
}

export function buildAssistedReviewPathCandidates(
  assistedHunks: readonly AssistedReviewHunk[],
  context?: ProjectRelativePathContext
): AssistedReviewPathCandidate[] {
  return assistedHunks.flatMap((entry, index) =>
    getToolPathProjectRelativeCandidates(entry.path, context).candidatePaths.map((pathValue) => ({
      path: pathValue,
      entry,
      index,
    }))
  );
}

/**
 * Parse a single `path[:range]` filter string. Returns null if the path is
 * empty or the range portion is malformed.
 */
export function parseAssistedFilter(input: string): ParsedAssistedFilter | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Split on the LAST ':' so paths containing colons (e.g. Windows drive letters,
  // though uncommon for workspace-relative paths) survive when the suffix is
  // not a valid range. We probe the suffix as a range first and fall back to
  // treating the whole string as a path.
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon === -1) {
    return { path: trimmed };
  }

  const maybePath = trimmed.slice(0, lastColon);
  const maybeRange = trimmed.slice(lastColon + 1);
  const range = parseLineRange(maybeRange);
  if (range && maybePath) {
    return { path: maybePath, range };
  }
  return { path: trimmed };
}

function parseLineRange(raw: string): { start: number; end: number } | null {
  const match = /^(\d+)(?:-(\d+))?$/.exec(raw.trim());
  if (!match) return null;
  const a = Number(match[1]);
  const b = match[2] ? Number(match[2]) : a;
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < 1) return null;
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

function hunkMatchesPathAndRange(
  hunk: DiffHunk,
  pathValue: string,
  range?: AssistedReviewHunk["range"]
): boolean {
  if (hunk.filePath !== pathValue && hunk.oldPath !== pathValue) {
    return false;
  }
  if (!range) return true;

  const { start, end } = range;
  const useOld = hunk.newLines === 0 && hunk.oldLines > 0;
  const hStart = useOld ? hunk.oldStart : hunk.newStart;
  const hLines = useOld ? hunk.oldLines : hunk.newLines;
  const hEnd = hStart + Math.max(hLines, 1) - 1;
  return hStart <= end && hEnd >= start;
}

/**
 * Test whether a {@link DiffHunk} satisfies an assisted path candidate.
 *
 * Path match is exact (project-relative). When the filter has no range, any
 * hunk in the file matches. Otherwise we check overlap against the hunk's
 * new-file span; for purely deleted regions (newLines=0) we fall back to the
 * old-file span so deletions can still be flagged.
 */
function hunkMatchesAssistedCandidate(
  hunk: DiffHunk,
  candidate: AssistedReviewPathCandidate
): boolean {
  return hunkMatchesPathAndRange(hunk, candidate.path, candidate.entry.range);
}

/**
 * For a given hunk, return the first matching assisted entry (and its index)
 * or null. The index lets the UI preserve the agent-declared ordering when
 * pinning matches to the top of the list.
 */
export function findAssistedCandidateMatch(
  hunk: DiffHunk,
  candidates: readonly AssistedReviewPathCandidate[]
): { entry: AssistedReviewHunk; index: number } | null {
  for (const candidate of candidates) {
    if (hunkMatchesAssistedCandidate(hunk, candidate)) {
      const entry =
        candidate.entry.path === candidate.path
          ? candidate.entry
          : { ...candidate.entry, path: candidate.path };
      return { entry, index: candidate.index };
    }
  }
  return null;
}

export function resolveAssistedReviewPathCandidatesForHunks(
  assistedHunks: readonly AssistedReviewHunk[],
  hunks: readonly DiffHunk[],
  context?: ProjectRelativePathContext
): AssistedReviewPathCandidate[] {
  return assistedHunks.flatMap((entry, index) => {
    const candidates = getToolPathProjectRelativeCandidates(entry.path, context);
    const primaryCandidate: AssistedReviewPathCandidate = {
      path: candidates.primaryPath,
      entry,
      index,
    };
    if (hunks.some((hunk) => hunkMatchesAssistedCandidate(hunk, primaryCandidate))) {
      return [primaryCandidate];
    }
    return candidates.candidatePaths.map((pathValue) => ({ path: pathValue, entry, index }));
  });
}

/**
 * Format an assisted hunk for display / round-trip back to the agent.
 */
export function formatAssistedFilter(hunk: AssistedReviewHunk): string {
  if (!hunk.range) return hunk.path;
  const { start, end } = hunk.range;
  return start === end ? `${hunk.path}:${start}` : `${hunk.path}:${start}-${end}`;
}
