import React from "react";
import { CircleCheck } from "lucide-react";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  StatusIndicator,
  ToolDetails,
  ErrorBox,
} from "./Shared/ToolPrimitives";
import {
  useToolExpansion,
  getStatusDisplay,
  isToolErrorResult,
  type ToolStatus,
} from "./Shared/toolUtils";
import {
  GoalToolStat,
  extractGoalFromResult,
  formatGoalBudgetSummary,
  formatGoalElapsed,
  formatGoalTurns,
  goalStatusLabel,
} from "./Goal/goalToolUtils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { useOptionalWorkspaceSidebarState } from "@/browser/stores/WorkspaceStore";
import type { GoalRecordV1, GoalSnapshot, GoalStatus } from "@/common/types/goal";

interface CompleteGoalToolCallProps {
  args: { summary: string };
  result?: unknown;
  status?: ToolStatus;
  workspaceId?: string;
}

interface CompleteGoalDisplayGoal {
  goalId: string;
  status: GoalStatus;
  objective: string;
  budgetCents: number | null;
  costCents: number;
  turnsUsed: number;
  turnCap: number | null;
  completionSummary?: string;
  startedAtMs: number;
}

export function getCompleteGoalDisplayGoal(
  resultGoal: GoalRecordV1 | null,
  liveGoal: GoalSnapshot | null | undefined,
  retainedLiveGoal: GoalSnapshot | null | undefined = null
): CompleteGoalDisplayGoal | null {
  if (resultGoal == null) {
    return null;
  }

  const freshestLiveGoal =
    liveGoal?.goalId === resultGoal.goalId
      ? liveGoal
      : retainedLiveGoal?.goalId === resultGoal.goalId
        ? retainedLiveGoal
        : null;

  if (freshestLiveGoal) {
    return {
      goalId: freshestLiveGoal.goalId,
      status: freshestLiveGoal.status,
      objective: freshestLiveGoal.objective,
      budgetCents: freshestLiveGoal.budgetCents,
      costCents: freshestLiveGoal.costCents,
      turnsUsed: freshestLiveGoal.turnsUsed,
      turnCap: freshestLiveGoal.turnCap,
      ...(freshestLiveGoal.completionSummary != null
        ? { completionSummary: freshestLiveGoal.completionSummary }
        : resultGoal.completionSummary != null
          ? { completionSummary: resultGoal.completionSummary }
          : {}),
      startedAtMs: freshestLiveGoal.startedAtMs,
    };
  }

  return {
    goalId: resultGoal.goalId,
    status: resultGoal.status,
    objective: resultGoal.objective,
    budgetCents: resultGoal.budgetCents,
    costCents: resultGoal.costCents,
    turnsUsed: resultGoal.turnsUsed,
    turnCap: resultGoal.turnCap,
    ...(resultGoal.completionSummary != null
      ? { completionSummary: resultGoal.completionSummary }
      : {}),
    startedAtMs: resultGoal.createdAtMs,
  };
}

export const CompleteGoalToolCall: React.FC<CompleteGoalToolCallProps> = ({
  args,
  result,
  status = "pending",
  workspaceId,
}) => {
  const { expanded, toggleExpanded } = useToolExpansion();
  const sidebarState = useOptionalWorkspaceSidebarState(workspaceId);
  const errorResult = isToolErrorResult(result) ? result : null;
  const resultGoal = extractGoalFromResult(result);
  const retainedLiveGoalRef = React.useRef<GoalSnapshot | null>(null);
  if (resultGoal && sidebarState?.goal?.goalId === resultGoal.goalId) {
    // Preserve the finalized same-goal accounting even if the user clears the
    // completed goal or starts a new one while this transcript card remains
    // mounted. Otherwise the card would regress to the stale pre-accounting
    // tool result.
    retainedLiveGoalRef.current = sidebarState.goal;
  }
  // `complete_goal` returns before the completing stream's final accounting is
  // known. Prefer the same-goal live snapshot when available so the transcript
  // card matches the finalized Goal sidebar cost/turn totals.
  const goal = getCompleteGoalDisplayGoal(
    resultGoal,
    sidebarState?.goal,
    retainedLiveGoalRef.current
  );
  const summary = (goal?.completionSummary ?? args.summary).trim();
  const succeeded = status === "completed" && !errorResult;
  const iconClassName = succeeded
    ? "text-success inline-flex shrink-0 items-center [&_svg]:size-3.5"
    : "text-secondary inline-flex shrink-0 items-center [&_svg]:size-3.5";

  return (
    <ToolContainer
      expanded={expanded}
      className={succeeded ? "border-success/40 bg-success/5 @container border-l-2" : "@container"}
    >
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={iconClassName}>
              <CircleCheck aria-hidden="true" />
            </span>
          </TooltipTrigger>
          <TooltipContent>complete_goal</TooltipContent>
        </Tooltip>
        <span className="font-medium whitespace-nowrap">Goal complete</span>
        {summary && <span className="text-foreground min-w-0 truncate italic">“{summary}”</span>}
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          {errorResult && <ErrorBox>{errorResult.error}</ErrorBox>}

          {summary && (
            <div className="mb-2">
              <div className="text-secondary text-[10px] tracking-wide uppercase">
                Completion summary
              </div>
              <div className="text-foreground text-[11px] leading-relaxed">{summary}</div>
            </div>
          )}

          {goal && (
            <div className="bg-code-bg space-y-2 rounded px-3 py-2 text-[11px] leading-relaxed">
              <div>
                <div className="text-secondary text-[10px] tracking-wide uppercase">Objective</div>
                <div className="text-foreground">{goal.objective}</div>
              </div>
              <dl className="grid grid-cols-1 gap-x-4 gap-y-1 @sm:grid-cols-2">
                <GoalToolStat label="Final status" value={goalStatusLabel(goal.status)} />
                <GoalToolStat
                  label="Cost"
                  value={
                    <span className="counter-nums">
                      {formatGoalBudgetSummary(goal.costCents, goal.budgetCents)}
                    </span>
                  }
                />
                <GoalToolStat
                  label="Turns"
                  value={
                    <span className="counter-nums">
                      {formatGoalTurns(goal.turnsUsed, goal.turnCap)}
                    </span>
                  }
                />
                <GoalToolStat
                  label="Elapsed"
                  value={
                    <span className="counter-nums">{formatGoalElapsed(goal.startedAtMs)}</span>
                  }
                />
              </dl>
            </div>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
