/**
 * Hook for managing read-more context expansion state in HunkViewer.
 * Handles loading additional context lines above/below a diff hunk.
 */

import { useState, useMemo, useEffect, useCallback } from "react";
import type { DiffHunk } from "@/common/types/review";
import { getReviewStateStore, useReviewStateSelector } from "@/browser/stores/ReviewStateStore";
import { useAPI } from "@/browser/contexts/API";
import { useWorkspaceMetadata } from "@/browser/contexts/WorkspaceContext";
import {
  readFileLines,
  formatAsContextLines,
  getOldFileRef,
  LINES_PER_EXPANSION,
} from "@/browser/utils/review/readFileLines";
import { resolveRepoRootProjectPath } from "@/browser/utils/executeBash";

/** Expansion state for a single hunk */
interface ReadMoreState {
  up: number; // Lines expanded upward (cumulative)
  down: number; // Lines expanded downward (cumulative)
}

const NO_EXPANSION: ReadMoreState = { up: 0, down: 0 };

interface UseReadMoreOptions {
  hunk: DiffHunk;
  hunkId: string;
  workspaceId: string;
  diffBase: string;
  includeUncommitted: boolean;
}

interface UseReadMoreResult {
  // Content
  upContent: string;
  downContent: string;
  // Loading states
  upLoading: boolean;
  downLoading: boolean;
  // Boundary states
  atBOF: boolean;
  atEOF: boolean;
  // Current expansion amounts
  readMore: ReadMoreState;
  // Handlers
  handleExpandUp: (e: React.MouseEvent) => void;
  handleExpandDown: (e: React.MouseEvent) => void;
  handleCollapseUp: (e: React.MouseEvent) => void;
  handleCollapseDown: (e: React.MouseEvent) => void;
}

export function useReadMore(options: UseReadMoreOptions): UseReadMoreResult {
  const { hunk, hunkId, workspaceId, diffBase, includeUncommitted } = options;
  const { api } = useAPI();
  const { workspaceMetadata } = useWorkspaceMetadata();
  const repoRootProjectPath = resolveRepoRootProjectPath(
    workspaceMetadata.get(workspaceId),
    hunk.filePath
  );

  // Persisted state (backend review-state store): how many lines expanded up/down per hunk.
  // Selected as primitives so other hunks' changes do not re-render this one.
  const up = useReviewStateSelector(
    workspaceId,
    (view) => view.sections.readMore?.[hunkId]?.up ?? NO_EXPANSION.up
  );
  const down = useReviewStateSelector(
    workspaceId,
    (view) => view.sections.readMore?.[hunkId]?.down ?? NO_EXPANSION.down
  );
  const readMore = useMemo(() => ({ up, down }), [up, down]);

  // Loading and content state (not persisted - reloads on mount)
  const [upContent, setUpContent] = useState<string>("");
  const [downContent, setDownContent] = useState<string>("");
  const [upLoading, setUpLoading] = useState(false);
  const [downLoading, setDownLoading] = useState(false);

  // BOF: true when hunk starts at line 1 (nothing to expand above)
  // For new files: oldStart=0 means no old content, so also BOF
  // For existing files: oldStart=1 means beginning of file
  const [atBOF, setAtBOF] = useState(() => hunk.oldStart <= 1);
  const [atEOF, setAtEOF] = useState(false);

  // Git ref expression to read from (merge-base for branch diffs)
  const gitRef = useMemo(
    () => getOldFileRef(diffBase, includeUncommitted),
    [diffBase, includeUncommitted]
  );

  // Load upward expansion content
  useEffect(() => {
    if (readMore.up === 0) {
      setUpContent("");
      // Keep BOF true if hunk starts at line 1 or is a new file (oldStart=0)
      setAtBOF(hunk.oldStart <= 1);
      return;
    }
    let cancelled = false;
    setUpLoading(true);

    const startLine = Math.max(1, hunk.oldStart - readMore.up);
    const endLine = hunk.oldStart - 1;

    void readFileLines(
      api,
      workspaceId,
      workspaceMetadata.get(workspaceId),
      hunk.filePath,
      startLine,
      endLine,
      gitRef,
      repoRootProjectPath
    ).then((lines) => {
      if (cancelled) return;
      setUpLoading(false);
      if (lines) {
        setUpContent(formatAsContextLines(lines));
        setAtBOF(startLine === 1 && lines.length < readMore.up);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    api,
    readMore.up,
    hunk.oldStart,
    hunk.filePath,
    workspaceId,
    workspaceMetadata,
    gitRef,
    repoRootProjectPath,
  ]);

  // Load downward expansion content
  useEffect(() => {
    if (readMore.down === 0) {
      setDownContent("");
      setAtEOF(false);
      return;
    }
    let cancelled = false;
    setDownLoading(true);

    const hunkEnd = hunk.oldStart + hunk.oldLines - 1;
    const startLine = hunkEnd + 1;
    const endLine = hunkEnd + readMore.down;

    void readFileLines(
      api,
      workspaceId,
      workspaceMetadata.get(workspaceId),
      hunk.filePath,
      startLine,
      endLine,
      gitRef,
      repoRootProjectPath
    ).then((lines) => {
      if (cancelled) return;
      setDownLoading(false);
      if (lines) {
        setDownContent(formatAsContextLines(lines));
        setAtEOF(lines.length < readMore.down);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    api,
    readMore.down,
    hunk.oldStart,
    hunk.oldLines,
    hunk.filePath,
    workspaceId,
    workspaceMetadata,
    gitRef,
    repoRootProjectPath,
  ]);

  // Expand/collapse handlers: pure updaters over the latest stored value (not the
  // render-time `readMore`), so rapid clicks and pre-hydration clicks compose correctly.
  const updateReadMore = useCallback(
    (update: (current: ReadMoreState) => ReadMoreState) => {
      getReviewStateStore().mutate(workspaceId, "readMore", (prev) => ({
        set: { [hunkId]: update(prev[hunkId] ?? NO_EXPANSION) },
      }));
    },
    [workspaceId, hunkId]
  );

  const handleExpandUp = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      updateReadMore((current) => ({ ...current, up: current.up + LINES_PER_EXPANSION }));
    },
    [updateReadMore]
  );

  const handleExpandDown = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      updateReadMore((current) => ({ ...current, down: current.down + LINES_PER_EXPANSION }));
    },
    [updateReadMore]
  );

  const handleCollapseUp = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      updateReadMore((current) => ({ ...current, up: 0 }));
    },
    [updateReadMore]
  );

  const handleCollapseDown = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      updateReadMore((current) => ({ ...current, down: 0 }));
    },
    [updateReadMore]
  );

  return {
    upContent,
    downContent,
    upLoading,
    downLoading,
    atBOF,
    atEOF,
    readMore,
    handleExpandUp,
    handleExpandDown,
    handleCollapseUp,
    handleCollapseDown,
  };
}
