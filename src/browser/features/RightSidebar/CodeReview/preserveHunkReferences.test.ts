import { describe, expect, it } from "bun:test";
import type { DiffHunk } from "@/common/types/review";
import { preserveHunkReferences } from "./preserveHunkReferences";

// Each refresh parses fresh hunk objects. Reusing the previous objects for
// unchanged hunks keeps memoized hunk rows from re-rendering, so these tests
// assert object identity, which the DOM never shows.
function hunk(id: string, content = `content of ${id}`): DiffHunk {
  return {
    id,
    filePath: "src/a.ts",
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    content,
    header: "@@ -1 +1 @@",
  };
}

describe("preserveHunkReferences", () => {
  it("returns the next list when there is no previous list", () => {
    const next = [hunk("a")];
    expect(preserveHunkReferences([], next)).toBe(next);
  });

  it("returns the previous list when every hunk is unchanged and in order", () => {
    const prev = [hunk("a"), hunk("b")];
    expect(preserveHunkReferences(prev, [hunk("a"), hunk("b")])).toBe(prev);
  });

  it("keeps unchanged hunk objects and takes the new object for a changed hunk", () => {
    const prev = [hunk("a"), hunk("b"), hunk("c")];
    const next = [hunk("a"), hunk("b", "edited"), hunk("c")];

    const result = preserveHunkReferences(prev, next);

    expect(result).not.toBe(prev);
    expect(result[0]).toBe(prev[0]);
    expect(result[1]).toBe(next[1]);
    expect(result[2]).toBe(prev[2]);
  });

  it("returns a new list in the next order when unchanged hunks move", () => {
    const prev = [hunk("a"), hunk("b")];

    const result = preserveHunkReferences(prev, [hunk("b"), hunk("a")]);

    expect(result).not.toBe(prev);
    expect(result[0]).toBe(prev[1]);
    expect(result[1]).toBe(prev[0]);
  });

  it("returns a new list when hunks are added or removed", () => {
    const prev = [hunk("a"), hunk("b")];

    const added = preserveHunkReferences(prev, [hunk("a"), hunk("b"), hunk("c")]);
    expect(added).not.toBe(prev);
    expect(added[0]).toBe(prev[0]);
    expect(added[1]).toBe(prev[1]);
    expect(added[2]?.id).toBe("c");
    expect(added[2]).not.toBe(prev[0]);

    const removed = preserveHunkReferences(prev, [hunk("a")]);
    expect(removed).not.toBe(prev);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toBe(prev[0]);
  });
});
