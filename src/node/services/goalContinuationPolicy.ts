import type { GoalRecordV1 } from "@/common/types/goal";
import type { SendMessageOptions } from "@/common/orpc/types";

const MICRO_CENTS_PER_CENT = 1_000_000;

export type GoalContinuationSkipReason =
  | "not_registered"
  | "no_pending_candidate"
  | "workspace_not_found"
  | "archived"
  | "transcript_only"
  | "initializing"
  | "incompatible_runtime"
  | "child_workspace"
  | "active_descendant_tasks"
  | "currently_streaming"
  | "queued_user_input"
  | "pending_follow_up"
  | "plan_mode"
  | "compact_mode"
  | "user_stop"
  | "goal_missing"
  | "goal_mismatch"
  | "goal_not_active"
  | "requires_ack"
  | "budget_wrapup_already_fired"
  | "budget_wrapup_suppressed"
  | "cooldown";

export type GoalStreamOriginKind = "goal_continuation" | "goal_budget_limit" | "user" | "other";

export type GoalContinuationDecision =
  | { kind: "continue"; mode: "continuation" | "budget_wrapup" }
  | { kind: "defer"; reason: GoalContinuationSkipReason; untilMs: number }
  | { kind: "stop"; reason: GoalContinuationSkipReason; dropCandidate: boolean };

export interface GoalContinuationPolicyCandidate {
  goalId: string;
  source: "stream_end" | "kickoff" | "budget_wrapup";
  sendOptions: Pick<SendMessageOptions, "agentId" | "mode">;
}

export interface GoalContinuationPolicyState {
  nowMs: number;
  bridgeRegistered: boolean;
  candidate: GoalContinuationPolicyCandidate | null;
  workspace: { found: boolean; archived: boolean; hasPath: boolean; isChild: boolean };
  hasActiveDescendantTasks: boolean;
  runtime: {
    isInitializing: boolean;
    isRuntimeCompatible: boolean;
    isBusy: boolean;
    hasQueuedMessages: boolean;
    hasPendingFollowUp: boolean;
  };
  isStreaming: boolean;
  userStopAtMs: number | null;
  stopCheckGoal: Pick<GoalRecordV1, "createdAtMs"> | null;
  goal: Pick<
    GoalRecordV1,
    | "goalId"
    | "status"
    | "requireUserAcknowledgmentSinceMs"
    | "budgetLimitInjectedForGoalId"
    | "lastContinuationFiredAtMs"
  > | null;
  lastStreamStamp: Pick<GoalStreamStamp, "goalId" | "originKind"> | null;
  continuationCooldownMs: number;
  allowUserOriginBudgetWrapup: boolean;
}

export interface GoalStreamStamp {
  goalId: string | null;
  originKind: GoalStreamOriginKind;
}

const stop = (
  reason: GoalContinuationSkipReason,
  dropCandidate: boolean
): GoalContinuationDecision => ({ kind: "stop", reason, dropCandidate });

export function evaluateGoalContinuationRegistration(
  state: Pick<GoalContinuationPolicyState, "candidate" | "bridgeRegistered">
): GoalContinuationDecision | null {
  if (!state.candidate) {
    return stop("no_pending_candidate", false);
  }
  if (!state.bridgeRegistered) {
    return stop("not_registered", false);
  }
  return null;
}

export function evaluateGoalContinuationWorkspace(
  state: Pick<GoalContinuationPolicyState, "workspace" | "hasActiveDescendantTasks">
): GoalContinuationDecision | null {
  if (!state.workspace.found) {
    return stop("workspace_not_found", true);
  }
  if (state.workspace.archived) {
    return stop("archived", true);
  }
  if (!state.workspace.hasPath) {
    return stop("transcript_only", true);
  }
  if (state.workspace.isChild) {
    return stop("child_workspace", true);
  }
  if (state.hasActiveDescendantTasks) {
    return stop("active_descendant_tasks", false);
  }
  return null;
}

export function evaluateGoalContinuationRuntime(
  state: Pick<GoalContinuationPolicyState, "nowMs" | "runtime" | "candidate"> & {
    isStreaming: boolean | null;
  }
): GoalContinuationDecision | null {
  if (state.runtime.isInitializing) {
    return { kind: "defer", reason: "initializing", untilMs: state.nowMs + 1_000 };
  }
  if (!state.runtime.isRuntimeCompatible) {
    return stop("incompatible_runtime", true);
  }
  if (state.runtime.isBusy || state.isStreaming === true) {
    return { kind: "defer", reason: "currently_streaming", untilMs: state.nowMs + 1_000 };
  }
  if (state.isStreaming == null) {
    return null;
  }
  if (state.runtime.hasQueuedMessages) {
    return stop("queued_user_input", false);
  }
  if (state.runtime.hasPendingFollowUp) {
    return stop("pending_follow_up", false);
  }
  const sendOptions = state.candidate?.sendOptions;
  if (sendOptions?.agentId === "plan" || sendOptions?.mode === "plan") {
    return stop("plan_mode", true);
  }
  if (sendOptions?.agentId === "compact" || sendOptions?.mode === "compact") {
    return stop("compact_mode", true);
  }
  return null;
}

export function evaluateGoalContinuationStopCheck(
  state: Pick<GoalContinuationPolicyState, "userStopAtMs" | "stopCheckGoal">
): GoalContinuationDecision | null {
  if (state.userStopAtMs == null) {
    return null;
  }
  if (!state.stopCheckGoal) {
    return stop("goal_missing", true);
  }
  if (state.userStopAtMs >= state.stopCheckGoal.createdAtMs) {
    return stop("user_stop", true);
  }
  return null;
}

export function evaluateGoalContinuationGoal(
  state: Pick<
    GoalContinuationPolicyState,
    | "nowMs"
    | "candidate"
    | "goal"
    | "lastStreamStamp"
    | "continuationCooldownMs"
    | "allowUserOriginBudgetWrapup"
  >
): GoalContinuationDecision {
  const candidate = state.candidate;
  const goal = state.goal;
  if (!goal || !candidate) {
    return stop("goal_missing", true);
  }
  if (goal.goalId !== candidate.goalId) {
    return stop("goal_mismatch", true);
  }
  if (
    goal.status !== "active" &&
    goal.status !== "budget_limited" &&
    (goal.status !== "paused" || candidate.source !== "kickoff")
  ) {
    return stop("goal_not_active", true);
  }
  if (goal.requireUserAcknowledgmentSinceMs != null) {
    return stop("requires_ack", false);
  }
  if (goal.status === "budget_limited") {
    if (goal.budgetLimitInjectedForGoalId === goal.goalId) {
      return stop("budget_wrapup_already_fired", true);
    }
    if (
      state.lastStreamStamp?.goalId !== goal.goalId ||
      !isBudgetWrapupEligibleOrigin(
        state.lastStreamStamp.originKind,
        state.allowUserOriginBudgetWrapup
      )
    ) {
      return stop("budget_wrapup_suppressed", true);
    }
    return { kind: "continue", mode: "budget_wrapup" };
  }
  const lastFiredAtMs = goal.lastContinuationFiredAtMs ?? null;
  if (lastFiredAtMs != null && state.nowMs - lastFiredAtMs < state.continuationCooldownMs) {
    return {
      kind: "defer",
      reason: "cooldown",
      untilMs: lastFiredAtMs + state.continuationCooldownMs,
    };
  }
  return { kind: "continue", mode: "continuation" };
}

export function evaluateGoalContinuation(
  state: GoalContinuationPolicyState
): GoalContinuationDecision {
  return (
    evaluateGoalContinuationRegistration(state) ??
    evaluateGoalContinuationWorkspace(state) ??
    evaluateGoalContinuationRuntime(state) ??
    evaluateGoalContinuationStopCheck(state) ??
    evaluateGoalContinuationGoal(state)
  );
}

function getGoalCostMicroCents(goal: GoalRecordV1): number {
  return goal.costMicroCents ?? goal.costCents * MICRO_CENTS_PER_CENT;
}

export function hasReachedGoalBudgetLimit(goal: GoalRecordV1): boolean {
  return (
    goal.budgetCents != null &&
    goal.budgetCents > 0 &&
    getGoalCostMicroCents(goal) >= goal.budgetCents * MICRO_CENTS_PER_CENT
  );
}

export function hasReachedGoalTurnLimit(goal: GoalRecordV1): boolean {
  return goal.turnCap != null && goal.turnsUsed >= goal.turnCap;
}

export function hasReachedAnyGoalLimit(goal: GoalRecordV1): boolean {
  return hasReachedGoalBudgetLimit(goal) || hasReachedGoalTurnLimit(goal);
}

export function isBudgetWrapupEligibleOrigin(
  originKind: GoalStreamOriginKind,
  allowUserOriginBudgetWrapup: boolean
): boolean {
  return allowUserOriginBudgetWrapup || originKind !== "user";
}

export function applyBudgetDrivenStatus(
  goal: GoalRecordV1,
  options: { originKind?: GoalStreamOriginKind; nowMs: number }
): GoalRecordV1 {
  const normalizedBudgetCents =
    goal.budgetCents != null && goal.budgetCents > 0 ? goal.budgetCents : null;
  const normalized =
    normalizedBudgetCents === goal.budgetCents
      ? goal
      : { ...goal, budgetCents: normalizedBudgetCents, updatedAtMs: options.nowMs };
  const reachedLimit = hasReachedAnyGoalLimit(normalized);
  const shouldLimitActiveGoal = normalized.status === "active" && reachedLimit;
  const shouldRearmBudgetLimitedGoal = normalized.status === "budget_limited" && !reachedLimit;
  if (!shouldLimitActiveGoal && !shouldRearmBudgetLimitedGoal) {
    return normalized;
  }
  return {
    ...normalized,
    status: shouldLimitActiveGoal ? "budget_limited" : "active",
    budgetLimitInjectedForGoalId: shouldRearmBudgetLimitedGoal
      ? null
      : normalized.budgetLimitInjectedForGoalId,
    budgetLimitOriginKind: shouldLimitActiveGoal
      ? (options.originKind ?? null)
      : shouldRearmBudgetLimitedGoal
        ? null
        : normalized.budgetLimitOriginKind,
    updatedAtMs: options.nowMs,
  };
}
