import { tool } from "ai";
import * as fs from "fs/promises";
import * as path from "path";
import writeFileAtomic from "@/node/utils/writeFileAtomic";
import assert from "@/common/utils/assert";
import type { ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { AssistedReviewHunk } from "@/common/types/review";
import {
  ASSISTED_REVIEW_MAX_HUNKS,
  formatAssistedFilter,
  getToolPathProjectRelativeCandidates,
  normalizeAssistedReviewHunk,
  normalizeToolPathToProjectRelative,
  parseAssistedFilter,
  type ProjectRelativePathContext,
} from "@/common/utils/review/assistedReview";
import {
  getAssistedReviewFilePath,
  readAssistedReviewForSessionDir,
} from "@/node/services/reviewPane/assistedReviewStorage";
import { workspaceFileLocks } from "@/node/utils/concurrency/workspaceFileLocks";

/**
 * Persistence for the agent's assisted-review focus list.
 *
 * The set is mirrored on disk (`<workspaceSessionDir>/assistedReview.json`)
 * because tool execution happens on the backend, where the in-memory state
 * does not survive process restarts. The frontend already rebuilds its view
 * from transcript replay; persisting the same data here keeps
 * `review_pane_get` and `review_pane_update(operation="add")` consistent
 * across restarts so the agent never sees a silently-emptied list and then
 * accidentally truncates prior flagged regions.
 *
 * The read/apply/write sequence (not just the write) goes through
 * `workspaceFileLocks` so concurrent `operation: "add"` calls from sibling
 * agents cannot both read the same baseline and clobber each other.
 */
async function writeAssistedReviewFile(
  workspaceSessionDir: string,
  hunks: AssistedReviewHunk[]
): Promise<void> {
  const filePath = getAssistedReviewFilePath(workspaceSessionDir);
  if (hunks.length === 0) {
    // Clean up the file when the agent clears its hint set so a stale
    // file can't shadow a fresh start.
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    return;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, JSON.stringify(hunks, null, 2));
}

async function applyReviewPaneUpdateForSessionDir(
  workspaceId: string,
  workspaceSessionDir: string,
  args: ReviewPaneUpdateArgs,
  pathContext?: ProjectRelativePathContext
): Promise<{ hunks: AssistedReviewHunk[]; rejected: string[] }> {
  return workspaceFileLocks.withLock(workspaceId, async () => {
    // Read prior state from disk so `operation: "add"` sees the right
    // baseline across app/backend restarts. The whole read-modify-write is
    // locked so concurrent `add` calls compose instead of last-writer-wins.
    const current = await readAssistedReviewForSessionDir(workspaceSessionDir);
    const result = applyReviewPaneUpdate(current, args, pathContext);
    // Persist before returning so a successful tool result is always backed
    // by durable state.
    await writeAssistedReviewFile(workspaceSessionDir, result.hunks);
    return result;
  });
}

interface ReviewPaneUpdateArgs {
  operation: "add" | "replace";
  hunks: Array<{ path: string; comment?: string | null }>;
}

function formatFallbackKeys(
  hunk: AssistedReviewHunk,
  pathContext?: ProjectRelativePathContext
): string[] {
  const exactKey = formatAssistedFilter(hunk);
  return getToolPathProjectRelativeCandidates(hunk.path, pathContext)
    .fallbackPaths.map((pathValue) => formatAssistedFilter({ ...hunk, path: pathValue }))
    .filter((key) => key !== exactKey);
}

/**
 * Apply an update operation against an existing list. Exported for testing
 * and to keep mutation logic in one place; the tool factory wraps this with
 * IO/validation.
 */
export function applyReviewPaneUpdate(
  current: readonly AssistedReviewHunk[],
  args: ReviewPaneUpdateArgs,
  pathContext?: ProjectRelativePathContext
): { hunks: AssistedReviewHunk[]; rejected: string[] } {
  const rejected: string[] = [];
  const parsed: AssistedReviewHunk[] = [];

  for (const raw of args.hunks) {
    const filter = parseAssistedFilter(raw.path);
    if (!filter) {
      rejected.push(raw.path);
      continue;
    }
    const trimmedComment = raw.comment?.trim();
    parsed.push({
      // Tool calls run from the agent's cwd, while Review stores project-relative
      // paths. Normalize explicit cwd-relative input here, then use candidate
      // keys below for ambiguous plain paths.
      path: normalizeToolPathToProjectRelative(filter.path, pathContext),
      range: filter.range,
      // Drop empty-after-trim comments so the UI doesn't render an empty
      // assisted-comment row.
      comment: trimmedComment && trimmedComment.length > 0 ? trimmedComment : undefined,
    });
  }

  const base =
    args.operation === "add"
      ? current.map((hunk) => normalizeAssistedReviewHunk(hunk, pathContext))
      : [];
  // Dedup by formatted path:range key, preferring the latest comment when
  // the same region is flagged twice (typical when an agent calls `add`
  // and then re-flags a refined comment). Exact keys are kept separate from
  // fallback keys: incoming ambiguous paths may refine a canonical fallback
  // that existed before this update, but incoming hunks don't fallback-match
  // each other, so root/scoped sibling pins can coexist regardless of order.
  const exactSeen = new Map<string, number>();
  const initialExactSeen = new Map<string, number>();
  const initialFallbackSeen = new Map<string, number>();
  base.forEach((h, index) => {
    const exactKey = formatAssistedFilter(h);
    exactSeen.set(exactKey, index);
    initialExactSeen.set(exactKey, index);
    for (const key of formatFallbackKeys(h, pathContext)) {
      initialFallbackSeen.set(key, index);
    }
  });
  for (const h of parsed) {
    const exactKey = formatAssistedFilter(h);
    let existing = exactSeen.get(exactKey);
    let replacementPath = existing === undefined ? h.path : (base[existing]?.path ?? h.path);
    if (existing === undefined) {
      for (const key of formatFallbackKeys(h, pathContext)) {
        existing = initialExactSeen.get(key) ?? initialFallbackSeen.get(key);
        replacementPath = existing === undefined ? h.path : (base[existing]?.path ?? h.path);
        if (existing !== undefined) break;
      }
    }
    if (existing !== undefined) {
      base[existing] = { ...h, path: replacementPath };
    } else {
      const nextIndex = base.length;
      exactSeen.set(exactKey, nextIndex);
      base.push(h);
    }
  }

  // Truncate defensively (single update can't exceed MAX, but `add` over time can).
  const truncated = base.slice(0, ASSISTED_REVIEW_MAX_HUNKS);
  return { hunks: truncated, rejected };
}

export const createReviewPaneUpdateTool: ToolFactory = (config) => {
  return tool({
    description: TOOL_DEFINITIONS.review_pane_update.description,
    inputSchema: TOOL_DEFINITIONS.review_pane_update.schema,
    execute: async (args) => {
      assert(config.workspaceId, "review_pane_update requires a workspaceId");
      assert(config.workspaceSessionDir, "review_pane_update requires workspaceSessionDir");
      if (args.hunks.length > ASSISTED_REVIEW_MAX_HUNKS) {
        throw new Error(
          `Too many hunks in a single update (${args.hunks.length}/${ASSISTED_REVIEW_MAX_HUNKS}). ` +
            "Flag the most important regions and consider splitting into multiple calls."
        );
      }

      const { hunks, rejected } = await applyReviewPaneUpdateForSessionDir(
        config.workspaceId,
        config.workspaceSessionDir,
        args,
        {
          projectPath: config.workspaceProjectPath,
          executionRootPath: config.workspaceExecutionRootPath,
        }
      );

      return {
        success: true as const,
        operation: args.operation,
        hunks: hunks.map((h) => ({
          path: formatAssistedFilter(h),
          comment: h.comment ?? null,
        })),
        rejected,
      };
    },
  });
};

export const createReviewPaneGetTool: ToolFactory = (config) => {
  return tool({
    description: TOOL_DEFINITIONS.review_pane_get.description,
    inputSchema: TOOL_DEFINITIONS.review_pane_get.schema,
    execute: async () => {
      assert(config.workspaceSessionDir, "review_pane_get requires workspaceSessionDir");
      const hunks = (await readAssistedReviewForSessionDir(config.workspaceSessionDir)).map(
        (hunk) =>
          normalizeAssistedReviewHunk(hunk, {
            projectPath: config.workspaceProjectPath,
            executionRootPath: config.workspaceExecutionRootPath,
          })
      );
      return {
        hunks: hunks.map((h) => ({
          path: formatAssistedFilter(h),
          comment: h.comment ?? null,
        })),
      };
    },
  });
};
