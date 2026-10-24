import * as path from "path";

import type { AssistedReviewHunk } from "@/common/types/review";
import { nodeSessionFiles } from "@/node/services/sessionFiles/nodeSessionFiles";
import type { SessionFiles } from "@/node/services/sessionFiles/sessionFiles";

/**
 * On-disk format for the agent's assisted-review focus list.
 *
 * Persisted under `<workspaceSessionDir>/assistedReview.json` (same shape as
 * `todos.json`) so that `review_pane_get` / `review_pane_update(operation="add")`
 * see a consistent set across app/backend restarts. Without this, the
 * Review pane (frontend) — which rebuilds from transcript replay — would
 * stay correct while the tool's in-memory view dropped to `[]`, silently
 * truncating prior flags on the next `add` call.
 */

const ASSISTED_REVIEW_FILE_NAME = "assistedReview.json";

/**
 * Get path to assistedReview.json file in the workspace's session directory.
 */
export function getAssistedReviewFilePath(workspaceSessionDir: string): string {
  return path.join(workspaceSessionDir, ASSISTED_REVIEW_FILE_NAME);
}

/**
 * Defensive coercion: drop entries that don't match the on-wire shape.
 * Mirrors `coerceTodoItems` so a hand-edited or partially-written file can't
 * crash the next read.
 */
export function coerceAssistedReviewHunks(value: unknown): AssistedReviewHunk[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const result: AssistedReviewHunk[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;

    const pathValue = (item as { path?: unknown }).path;
    const rangeValue = (item as { range?: unknown }).range;
    const commentValue = (item as { comment?: unknown }).comment;

    if (typeof pathValue !== "string" || pathValue.length === 0) continue;

    let range: AssistedReviewHunk["range"] | undefined;
    if (rangeValue && typeof rangeValue === "object") {
      const start = (rangeValue as { start?: unknown }).start;
      const end = (rangeValue as { end?: unknown }).end;
      if (
        typeof start === "number" &&
        typeof end === "number" &&
        Number.isFinite(start) &&
        Number.isFinite(end)
      ) {
        range = { start, end };
      }
    }

    const comment =
      typeof commentValue === "string" && commentValue.length > 0 ? commentValue : undefined;

    result.push({ path: pathValue, range, comment });
  }

  return result;
}

/**
 * Read the assisted-review hunks for a workspace session directory.
 * Returns `[]` on missing file or any read/parse failure so the next tool
 * call starts from a clean baseline rather than crashing. `files` is the session's SessionFiles
 * (the memory volume in the in-memory loop). Callers outside the loop keep the Node default.
 */
export async function readAssistedReviewForSessionDir(
  workspaceSessionDir: string,
  files: SessionFiles = nodeSessionFiles
): Promise<AssistedReviewHunk[]> {
  const filePath = getAssistedReviewFilePath(workspaceSessionDir);
  try {
    const content = await files.promises.readFile(filePath, "utf-8");
    const parsed: unknown = JSON.parse(content);
    return coerceAssistedReviewHunks(parsed);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    // Other read/parse errors fall back to empty rather than throwing so a
    // corrupted file doesn't brick the tool indefinitely — mirrors
    // `readTodosForSessionDir`.
    return [];
  }
}
