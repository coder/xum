import type { APIClient } from "@/browser/contexts/API";
import { isGoalPendingPersistence, type GoalSnapshot } from "@/common/types/goal";

/**
 * Optimistic-concurrency write shared by every browser-side goal mutation
 * entry point: the sidebar, `/goal` slash commands and the command palette
 * (Coder-agents-review P3 DEREM-25 consolidated three copies).
 *
 * `intendedGoalId` is the goal the user acted on: the goal the caller
 * displayed (`null` when it showed no goal). Callers without a displayed goal
 * (slash commands) omit it, and the helper reads the current goal once.
 *
 * A `goal_conflict` is returned as is, never retried with a re-read goal id
 * (#5461). The backend reports a conflict only when the goal id changed, so a
 * retry would apply a pause, budget edit, rename or completion meant for one
 * goal to its replacement. Callers surface "Goal changed in another window.
 * Please try again." instead.
 */
/**
 * The `intendedGoalId` for a caller that displays `goal`. A goal still pending persistence (a
 * replacement queued until the stream ends) has no durable id the backend can compare yet, so
 * the helper reads the current goal instead.
 */
export function intendedGoalIdOf(goal: GoalSnapshot | null | undefined): string | null | undefined {
  if (isGoalPendingPersistence(goal)) return undefined;
  return goal?.goalId ?? null;
}

export async function setGoalForIntendedGoal(
  api: APIClient,
  workspaceId: string,
  // Use `Omit` to forbid `workspaceId`/`expectedGoalId` in the input — the
  // helper supplies both.
  input: Omit<Parameters<APIClient["workspace"]["setGoal"]>[0], "workspaceId" | "expectedGoalId">,
  intendedGoalId?: string | null
): Promise<Awaited<ReturnType<APIClient["workspace"]["setGoal"]>>> {
  const expectedGoalId =
    intendedGoalId !== undefined
      ? intendedGoalId
      : ((await api.workspace.getGoal({ workspaceId })).goal?.goalId ?? null);
  return api.workspace.setGoal({ workspaceId, ...input, expectedGoalId });
}
