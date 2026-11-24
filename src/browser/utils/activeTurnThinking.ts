import type { APIClient } from "@/browser/contexts/API";
import type { ThinkingLevel } from "@/common/types/thinking";

/**
 * Best-effort request to apply a thinking-level change to the active turn's
 * NEXT model step (mid-turn override). Shared by every UI path that changes a
 * workspace's thinking level (selector, keybinds, command palette) so they all
 * behave identically during a stream.
 *
 * No streaming gate on purpose: the backend no-ops cheaply (accepted: false)
 * when the workspace is idle or unknown, and the persisted workspace setting
 * (updated separately by callers) still covers future turns.
 */
export function requestActiveTurnThinkingLevel(
  api: APIClient | null | undefined,
  workspaceId: string,
  thinkingLevel: ThinkingLevel
): void {
  if (!api || !workspaceId) {
    return;
  }
  api.workspace.setActiveTurnThinkingLevel({ workspaceId, thinkingLevel }).catch(() => {
    // Best-effort: transient IPC failure loses only the mid-turn nudge.
  });
}
