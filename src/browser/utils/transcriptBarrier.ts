import { useSyncExternalStore } from "react";

import { workspaceStore } from "@/browser/stores/WorkspaceStore";
import type { ParsedCommand } from "@/browser/utils/slashCommands/types";
import assert from "@/common/utils/assert";

/**
 * Transcript mutation barrier.
 *
 * Every user action whose meaning depends on the visible transcript — sends, edits, `/clear`,
 * `/reset`, plan-proposal sends — must be refused until the active onChat subscription has
 * delivered a *complete* history replay for the workspace. The check is cheap and is meant to
 * run at dispatch time (after every await), not only when rendering disabled states, so a
 * transcript that stops being current mid-resolution still refuses the mutation.
 *
 * Stop/interrupt, resume, queue operations and goals are deliberately not gated: they act on
 * backend state by id and stay usable while the transcript hydrates.
 */
export function isTranscriptMutationAllowed(workspaceId: string): boolean {
  assert(typeof workspaceId === "string" && workspaceId.length > 0, "workspaceId required");
  return workspaceStore.isWorkspaceTranscriptCaughtUp(workspaceId);
}

const noopUnsubscribe = () => undefined;

/**
 * Render-time view of the barrier for disabled states, so an affordance never looks enabled
 * while its click would be refused. Dispatch sites still call `isTranscriptMutationAllowed`.
 */
export function useTranscriptMutationAllowed(workspaceId: string | undefined): boolean {
  return useSyncExternalStore(
    (listener) =>
      workspaceId ? workspaceStore.subscribeKey(workspaceId, listener) : noopUnsubscribe,
    () => (workspaceId ? workspaceStore.isWorkspaceTranscriptCaughtUp(workspaceId) : false)
  );
}

/**
 * Typed slash commands that neither send a message nor touch history: goals act on backend
 * goal state by id, the rest change local settings or open views. They stay usable while the
 * transcript hydrates; every other draft (plain text, edits, /clear, /reset, /compact, /fork,
 * /new, one-shot model sends, unknown commands) goes through the barrier.
 */
export function commandBypassesTranscriptBarrier(parsed: ParsedCommand): boolean {
  if (parsed === null) return false;
  switch (parsed.type) {
    case "goal-show":
    case "goal-set":
    case "goal-budget":
    case "goal-pause":
    case "goal-resume":
    case "goal-complete":
    case "goal-clear":
    case "model-set":
    case "model-help":
    case "vim-toggle":
    case "plan-show":
    case "plan-open":
    case "heartbeat-set":
    case "idle-compaction":
    case "debug-llm-request":
      return true;
    default:
      return false;
  }
}
