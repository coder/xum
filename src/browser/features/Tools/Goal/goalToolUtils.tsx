import React from "react";
import { Target } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { GoalRecordV1Schema } from "@/common/orpc/schemas/goal";
import type { GoalRecordV1, GoalStatus } from "@/common/types/goal";
// Re-export the canonical formatter from common/utils so the rest of the app
// has one place to import from and we keep the assert guard intact across
// callers (Coder-agents-review P2 DEREM-11).
import { formatGoalCents } from "@/common/utils/goals/budgetPricing";
export { formatGoalCents };

export function formatGoalElapsed(startedAtMs: number, nowMs: number = Date.now()): string {
  const elapsedMs = Math.max(0, nowMs - startedAtMs);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) {
    return "<1m";
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 1) {
    return `${minutes}m`;
  }
  return `${hours}h ${minutes % 60}m`;
}

// Shared turn-count pluralization so the goal toolcards render "1 turn" /
// "N turns" consistently (was open-coded in formatGoalTurns and the set_goal
// toolcard's requested-turns formatter).
export function pluralizeTurns(count: number): string {
  return `${count} turn${count === 1 ? "" : "s"}`;
}

export function formatGoalTurns(turnsUsed: number, turnCap: number | null): string {
  return turnCap == null ? pluralizeTurns(turnsUsed) : `${turnsUsed} / ${turnCap} turns`;
}

export function formatGoalBudgetSummary(costCents: number, budgetCents: number | null): string {
  if (budgetCents == null) {
    return formatGoalCents(costCents);
  }
  return `${formatGoalCents(costCents)} / ${formatGoalCents(budgetCents)}`;
}

// Status labels reflect the conceptual model: `Active` (with a sub-mode in
// parentheses when the goal is not running) is the workspace's lifecycle-
// active goal; `Complete` is terminal. Paused / budget-limited are sub-
// statuses *of* active — see `goalLifecycle()` / `goalActiveMode()` in
// `src/common/types/goal.ts` for the storage→concept mapping.
const STATUS_LABELS: Record<GoalStatus, string> = {
  active: "Active",
  paused: "Active (paused)",
  budget_limited: "Active (budget limited)",
  complete: "Complete",
};

export function goalStatusLabel(status: GoalStatus): string {
  return STATUS_LABELS[status];
}

// Color semantics:
//   success/green — the active goal is running (or terminally complete).
//   warning/amber — the active goal is paused or budget-limited
//     (lifecycle-active but NOT auto-running). Amber consistently means
//     "this goal is the workspace's active goal but won't progress until
//     you act" so users can spot a stalled workspace at a glance — the
//     band color matches the Goals-tab header tone and the sidebar tab
//     label accent for the same status.
const STATUS_BADGE_CLASSES: Record<GoalStatus, string> = {
  active: "bg-success/10 text-success border-success/40",
  paused: "bg-warning-overlay text-warning border-warning/40",
  budget_limited: "bg-warning-overlay text-warning border-warning/40",
  complete: "bg-success/10 text-success border-success/40",
};

interface GoalStatusBadgeProps {
  status: GoalStatus;
  className?: string;
}

export const GoalStatusBadge: React.FC<GoalStatusBadgeProps> = ({ status, className }) => (
  <span
    className={cn(
      "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none uppercase tracking-wide",
      STATUS_BADGE_CLASSES[status],
      className
    )}
  >
    <Target aria-hidden="true" className="h-2.5 w-2.5" />
    {goalStatusLabel(status)}
  </span>
);

interface GoalToolStatProps {
  label: string;
  value: React.ReactNode;
}

export const GoalToolStat: React.FC<GoalToolStatProps> = ({ label, value }) => (
  <div className="flex items-baseline gap-1.5">
    <dt className="text-secondary text-[10px] tracking-wide uppercase">{label}</dt>
    <dd className="text-foreground">{value}</dd>
  </div>
);

export function extractGoalFromResult(result: unknown): GoalRecordV1 | null {
  if (!result || typeof result !== "object" || !("goal" in result)) {
    return null;
  }

  const parsed = GoalRecordV1Schema.safeParse(result.goal);
  return parsed.success ? parsed.data : null;
}
