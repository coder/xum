import React from "react";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  StatusIndicator,
  ToolDetails,
  ToolIcon,
  ErrorBox,
} from "./Shared/ToolPrimitives";
import {
  useToolExpansion,
  getStatusDisplay,
  isToolErrorResult,
  type ToolStatus,
} from "./Shared/toolUtils";
import {
  GoalStatusBadge,
  GoalToolStat,
  extractGoalFromResult,
  formatGoalCents,
  formatGoalTurns,
  pluralizeTurns,
} from "./Goal/goalToolUtils";

interface SetGoalToolCallProps {
  args: {
    objective: string;
    budgetCents?: number | null;
    turnCap?: number | null;
    replaceExistingGoal?: boolean | null;
    expectedGoalId?: string | null;
  };
  result?: unknown;
  status?: ToolStatus;
}

function formatOptionalBudget(budgetCents: number | null | undefined): string {
  return budgetCents == null ? "Workspace default" : formatGoalCents(budgetCents);
}

function formatAppliedBudget(budgetCents: number | null): string {
  return budgetCents == null ? "No budget" : formatGoalCents(budgetCents);
}

function formatOptionalTurnCap(turnCap: number | null | undefined): string {
  return turnCap == null ? "Workspace default" : pluralizeTurns(turnCap);
}

export const SetGoalToolCall: React.FC<SetGoalToolCallProps> = ({
  args,
  result,
  status = "pending",
}) => {
  const { expanded, toggleExpanded } = useToolExpansion();
  const errorResult = isToolErrorResult(result) ? result : null;
  const goal = extractGoalFromResult(result);
  const objective = args.objective.trim();

  return (
    <ToolContainer expanded={expanded} className="@container">
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName="set_goal" />
        <span className="text-secondary font-medium whitespace-nowrap">Set goal</span>
        {goal && <GoalStatusBadge status={goal.status} />}
        {objective && (
          <span className="text-foreground min-w-0 truncate italic">“{objective}”</span>
        )}
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          {errorResult && <ErrorBox>{errorResult.error}</ErrorBox>}

          <div className="bg-code-bg space-y-2 rounded px-3 py-2 text-[11px] leading-relaxed">
            <div>
              <div className="text-secondary text-[10px] tracking-wide uppercase">Objective</div>
              <div className="text-foreground break-words">{objective}</div>
            </div>

            <dl className="grid grid-cols-1 gap-x-4 gap-y-1 @sm:grid-cols-2">
              <GoalToolStat
                label="Requested budget"
                value={formatOptionalBudget(args.budgetCents)}
              />
              <GoalToolStat label="Requested turns" value={formatOptionalTurnCap(args.turnCap)} />
              <GoalToolStat
                label="Replace"
                value={args.replaceExistingGoal === true ? "Explicit" : "No"}
              />
              {args.expectedGoalId && (
                <GoalToolStat
                  label="Expected ID"
                  value={
                    <span className="font-mono text-[10px] break-all">{args.expectedGoalId}</span>
                  }
                />
              )}
              {goal && (
                <GoalToolStat label="Status" value={<GoalStatusBadge status={goal.status} />} />
              )}
              {goal && (
                <GoalToolStat
                  label="Applied budget"
                  value={formatAppliedBudget(goal.budgetCents)}
                />
              )}
              {goal && (
                <GoalToolStat
                  label="Applied turns"
                  value={
                    <span className="counter-nums">
                      {formatGoalTurns(goal.turnsUsed, goal.turnCap)}
                    </span>
                  }
                />
              )}
            </dl>
          </div>
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
