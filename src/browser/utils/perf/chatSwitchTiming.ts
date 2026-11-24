/**
 * User Timing marks for chat (workspace) switches.
 *
 * Why (#4504): switching back to a mid-stream chat shows the transcript skeleton until the
 * server's `caught-up`. These measures time each visible phase from the moment the store makes
 * the workspace active, so perf scenarios (and DevTools' Performance panel) can read them with
 * `performance.getEntriesByType("measure")`. Names are fixed and every new switch clears the
 * previous switch's entries, so the performance buffer stays bounded.
 *
 * Timing points: `caught-up` when the store processes it; `skeleton-shown` and `first-row` at
 * the next animation frame after the commit that mounted them (≈ paint; a commit replaced by a
 * synchronous re-render before paint is dropped); `skeleton-hidden` at the unmount commit
 * (paint follows in the same frame). Callers run from passive effects because the start mark
 * is set in an ancestor's layout effect, which runs after descendant layout effects.
 */

export type ChatSwitchMilestone = "skeleton-shown" | "skeleton-hidden" | "first-row" | "caught-up";

export const CHAT_SWITCH_MARK_PREFIX = "xum:chat-switch:";
export const CHAT_SWITCH_START_MARK = `${CHAT_SWITCH_MARK_PREFIX}start`;

const MILESTONES: readonly ChatSwitchMilestone[] = [
  "skeleton-shown",
  "skeleton-hidden",
  "first-row",
  "caught-up",
];

interface PendingSwitch {
  workspaceId: string;
  recorded: Set<ChatSwitchMilestone>;
}

let pendingSwitch: PendingSwitch | null = null;

function hasUserTiming(): boolean {
  // bun tests / happy-dom may lack mark/measure; timing is optional there.
  return (
    typeof performance !== "undefined" &&
    typeof performance.mark === "function" &&
    typeof performance.measure === "function" &&
    typeof performance.clearMarks === "function" &&
    typeof performance.clearMeasures === "function"
  );
}

/** Start timing a switch to `workspaceId`. Drops any previous switch's entries. */
export function markChatSwitchStart(workspaceId: string): void {
  if (!hasUserTiming()) return;
  performance.clearMarks(CHAT_SWITCH_START_MARK);
  for (const milestone of MILESTONES) {
    performance.clearMeasures(`${CHAT_SWITCH_MARK_PREFIX}${milestone}`);
  }
  pendingSwitch = { workspaceId, recorded: new Set() };
  performance.mark(CHAT_SWITCH_START_MARK, { detail: { workspaceId } });
}

/**
 * Record `milestone` for the pending switch. No-op unless the latest switch targeted
 * `workspaceId` and the milestone was not recorded yet, so callers can report freely.
 */
export function markChatSwitchMilestone(
  workspaceId: string,
  milestone: ChatSwitchMilestone,
  detail?: Record<string, unknown>
): void {
  if (!hasUserTiming()) return;
  if (pendingSwitch?.workspaceId !== workspaceId) return;
  // skeleton-hidden only has meaning after this switch showed the skeleton.
  if (milestone === "skeleton-hidden" && !pendingSwitch.recorded.has("skeleton-shown")) return;
  if (pendingSwitch.recorded.has(milestone)) return;
  pendingSwitch.recorded.add(milestone);
  performance.measure(`${CHAT_SWITCH_MARK_PREFIX}${milestone}`, {
    start: CHAT_SWITCH_START_MARK,
    detail: { workspaceId, ...detail },
  });
}

/**
 * Record `milestone` at the next animation frame unless the returned cancel runs first (effect
 * cleanup when the commit is replaced before paint). No-op where rAF is unavailable.
 */
export function markChatSwitchMilestoneOnNextFrame(
  workspaceId: string,
  milestone: ChatSwitchMilestone
): () => void {
  if (!hasUserTiming() || typeof requestAnimationFrame !== "function") return () => undefined;
  const frame = requestAnimationFrame(() => markChatSwitchMilestone(workspaceId, milestone));
  return () => cancelAnimationFrame(frame);
}
