import type { DiffHunk } from "@/common/types/review";

/**
 * Preserve object references for unchanged hunks to prevent re-renders.
 * Compares by ID and content - if a hunk exists in prev with same content, reuse it.
 */
export function preserveHunkReferences(prev: DiffHunk[], next: DiffHunk[]): DiffHunk[] {
  if (prev.length === 0) return next;

  const prevById = new Map(prev.map((h) => [h.id, h]));
  let allSame = prev.length === next.length;

  const result = next.map((hunk, i) => {
    const prevHunk = prevById.get(hunk.id);
    // Fast path: same ID and content means unchanged (content hash is part of ID)
    if (prevHunk?.content === hunk.content) {
      if (allSame && prev[i]?.id !== hunk.id) allSame = false;
      return prevHunk;
    }
    allSame = false;
    return hunk;
  });

  // If all hunks are reused in same order, return prev array to preserve top-level reference
  return allSame ? prev : result;
}
