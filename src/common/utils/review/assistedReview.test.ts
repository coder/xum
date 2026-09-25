import { describe, expect, it } from "bun:test";
import type { AssistedReviewHunk, DiffHunk } from "@/common/types/review";
import {
  buildAssistedReviewPathCandidates,
  deriveProjectRelativePath,
  findAssistedCandidateMatch,
  formatAssistedFilter,
  getToolPathProjectRelativeCandidates,
  normalizeAssistedReviewHunk,
  normalizeToolPathToProjectRelative,
  parseAssistedFilter,
  resolveAssistedReviewPathCandidatesForHunks,
} from "./assistedReview";

const baseHunk = (overrides: Partial<DiffHunk> = {}): DiffHunk => ({
  id: "h1",
  filePath: "src/foo.ts",
  oldStart: 1,
  oldLines: 0,
  newStart: 10,
  newLines: 5,
  content: "",
  header: "@@",
  ...overrides,
});

describe("project-relative path normalization", () => {
  const context = {
    projectPath: "/repo/app",
    executionRootPath: "/repo/app/packages/api",
  };

  it("derives normalized project-relative paths", () => {
    expect(deriveProjectRelativePath("C:\\repo\\app", "C:\\repo\\app\\packages\\api")).toBe(
      "packages/api"
    );
    expect(deriveProjectRelativePath("/repo/app", "/other/packages/api")).toBeNull();
  });

  it("keeps ambiguous plain paths primary but adds an execution-root fallback", () => {
    const candidates = getToolPathProjectRelativeCandidates("src/foo.ts", context);
    expect(candidates.primaryPath).toBe("src/foo.ts");
    expect(candidates.candidatePaths).toEqual(["src/foo.ts", "packages/api/src/foo.ts"]);
  });

  it("leaves project-relative assisted paths unchanged", () => {
    expect(normalizeToolPathToProjectRelative("packages/api/src/foo.ts", context)).toBe(
      "packages/api/src/foo.ts"
    );
    expect(getToolPathProjectRelativeCandidates("README.md", context).candidatePaths).toEqual([
      "README.md",
    ]);
    expect(
      getToolPathProjectRelativeCandidates("packages/shared.ts", context).candidatePaths
    ).toEqual(["packages/shared.ts"]);
  });

  it("resolves explicit cwd-relative paths from the execution root", () => {
    expect(normalizeToolPathToProjectRelative("./src/foo.ts", context)).toBe(
      "packages/api/src/foo.ts"
    );
    expect(normalizeToolPathToProjectRelative("../shared.ts", context)).toBe("packages/shared.ts");
    expect(normalizeToolPathToProjectRelative("../../README.md", context)).toBe("README.md");
  });

  it("preserves hunk metadata while normalizing explicit cwd-relative paths", () => {
    expect(
      normalizeAssistedReviewHunk(
        { path: "./src/foo.ts", range: { start: 3, end: 5 }, comment: "check this", addedAt: 12 },
        context
      )
    ).toEqual({
      path: "packages/api/src/foo.ts",
      range: { start: 3, end: 5 },
      comment: "check this",
      addedAt: 12,
    });
  });

  it("resolves ambiguous candidates by preferring a matching primary path", () => {
    const assisted = [{ path: "src/foo.ts" }];
    const hunks = [
      baseHunk({ id: "root", filePath: "src/foo.ts" }),
      baseHunk({ id: "scoped", filePath: "packages/api/src/foo.ts" }),
    ];

    const candidates = resolveAssistedReviewPathCandidatesForHunks(assisted, hunks, context);

    expect(candidates.map((candidate) => candidate.path)).toEqual(["src/foo.ts"]);
    expect(findAssistedCandidateMatch(hunks[0], candidates)?.entry.path).toBe("src/foo.ts");
    expect(findAssistedCandidateMatch(hunks[1], candidates)).toBeNull();
  });

  it("falls back to execution-root candidates when the primary path has no matching hunk", () => {
    const assisted = [{ path: "src/foo.ts" }];
    const hunks = [baseHunk({ id: "scoped", filePath: "packages/api/src/foo.ts" })];

    const candidates = resolveAssistedReviewPathCandidatesForHunks(assisted, hunks, context);

    expect(candidates.map((candidate) => candidate.path)).toEqual([
      "src/foo.ts",
      "packages/api/src/foo.ts",
    ]);
    expect(findAssistedCandidateMatch(hunks[0], candidates)?.entry.path).toBe(
      "packages/api/src/foo.ts"
    );
  });
});

describe("parseAssistedFilter", () => {
  it("returns null for empty input", () => {
    expect(parseAssistedFilter("")).toBeNull();
    expect(parseAssistedFilter("   ")).toBeNull();
  });

  it("parses whole-file path", () => {
    expect(parseAssistedFilter("src/foo.ts")).toEqual({ path: "src/foo.ts" });
  });

  it("parses single-line range", () => {
    expect(parseAssistedFilter("src/foo.ts:42")).toEqual({
      path: "src/foo.ts",
      range: { start: 42, end: 42 },
    });
  });

  it("parses inclusive range", () => {
    expect(parseAssistedFilter("src/foo.ts:10-20")).toEqual({
      path: "src/foo.ts",
      range: { start: 10, end: 20 },
    });
  });

  it("normalizes reversed range", () => {
    expect(parseAssistedFilter("src/foo.ts:20-10")?.range).toEqual({ start: 10, end: 20 });
  });

  it("falls back to whole-file when range portion is malformed", () => {
    // The trailing ':bogus' is treated as part of the path so we don't
    // silently drop unparseable user input.
    expect(parseAssistedFilter("src/foo.ts:bogus")).toEqual({ path: "src/foo.ts:bogus" });
  });
});

describe("findAssistedCandidateMatch", () => {
  const findMatch = (hunk: DiffHunk, assisted: AssistedReviewHunk[]) =>
    findAssistedCandidateMatch(hunk, buildAssistedReviewPathCandidates(assisted));

  it("matches whole-file filter regardless of range", () => {
    expect(findMatch(baseHunk(), [{ path: "src/foo.ts" }])?.index).toBe(0);
  });

  it("matches overlapping new-side range", () => {
    expect(
      findMatch(baseHunk(), [{ path: "src/foo.ts", range: { start: 12, end: 13 } }])
    ).not.toBeNull();
  });

  it("rejects non-overlapping range", () => {
    expect(
      findMatch(baseHunk(), [{ path: "src/foo.ts", range: { start: 100, end: 200 } }])
    ).toBeNull();
  });

  it("falls back to old-side span for pure deletions", () => {
    const deletion = baseHunk({ newLines: 0, oldStart: 50, oldLines: 4 });
    expect(
      findMatch(deletion, [{ path: "src/foo.ts", range: { start: 52, end: 52 } }])
    ).not.toBeNull();
  });

  it("matches via oldPath when file was renamed", () => {
    const renamed = baseHunk({ filePath: "src/new.ts", oldPath: "src/old.ts" });
    expect(findMatch(renamed, [{ path: "src/old.ts" }])?.entry.path).toBe("src/old.ts");
  });

  it("returns first match with its declared index", () => {
    const result = findMatch(baseHunk(), [
      { path: "src/other.ts" },
      { path: "src/foo.ts", range: { start: 10, end: 14 }, comment: "Look here" },
      { path: "src/foo.ts" },
    ]);
    expect(result?.index).toBe(1);
    expect(result?.entry.comment).toBe("Look here");
  });

  it("returns null when nothing matches", () => {
    expect(findMatch(baseHunk(), [{ path: "src/other.ts" }])).toBeNull();
  });
});

describe("formatAssistedFilter", () => {
  it("round-trips whole-file paths", () => {
    expect(formatAssistedFilter({ path: "src/foo.ts" })).toBe("src/foo.ts");
  });

  it("formats single-line ranges without a hyphen", () => {
    expect(formatAssistedFilter({ path: "a", range: { start: 5, end: 5 } })).toBe("a:5");
  });

  it("formats multi-line ranges", () => {
    expect(formatAssistedFilter({ path: "a", range: { start: 5, end: 9 } })).toBe("a:5-9");
  });
});
