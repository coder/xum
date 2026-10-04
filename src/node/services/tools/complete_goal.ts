import { tool } from "ai";
import assert from "@/common/utils/assert";
import type { ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { getGoalToolAvailability } from "@/common/utils/tools/toolAvailability";
import { formatGoalSetError, noActiveGoalRefusal } from "./goalErrors";

export const createCompleteGoalTool: ToolFactory = (config) => {
  return tool({
    description: TOOL_DEFINITIONS.complete_goal.description,
    inputSchema: TOOL_DEFINITIONS.complete_goal.schema,
    execute: async ({ summary, goalId }) => {
      assert(config.workspaceId, "complete_goal requires workspaceId");
      assert(config.goalService, "complete_goal requires goalService");
      assert(config.goalToolContext, "complete_goal requires goalToolContext");
      assert(summary.trim().length > 0, "complete_goal requires a non-empty summary");

      // Execution-time gate (#5247): the tool is registered on every turn, so
      // refuse calls without an active goal here with a typed result. Any agent
      // that drives a goal may complete it, read-only research agents included.
      // The service still re-validates the transition under its lock, so a goal
      // that changes after this read surfaces as a typed error.
      const current = await config.goalService.getGoal(config.workspaceId);
      const { completeGoal: completable } = getGoalToolAvailability({
        ...config.goalToolContext,
        goalStatus: current?.status ?? null,
      });
      if (!completable) {
        return noActiveGoalRefusal(current?.status ?? null);
      }

      // Without a model-provided goalId, an automatic goal turn targets the goal it was
      // dispatched for: a goal the user replaced after dispatch is refused, not completed
      // (#5461). Other turns keep completing the current goal.
      const expectedGoalId = goalId ?? config.goalToolContext.goalId;
      const result = await config.goalService.setGoal({
        workspaceId: config.workspaceId,
        status: "complete",
        completionSummary: summary,
        initiator: "model",
        // A user, delegated or heartbeat turn may run a one-shot agent other than the
        // workspace's selected one (e.g. explore on an exec goal): only the selected agent,
        // which drives the goal's automatic turns, may complete it there. Automatic goal turns
        // are the goal loop itself and keep completing it.
        ...(config.goalToolContext.goalTurnKind == null
          ? { requireSelectedAgentId: config.goalToolContext.agentId }
          : {}),
        // Forward the model-provided optimistic-concurrency token so a goal
        // that was cleared or replaced mid-stream surfaces as a typed
        // `goal_conflict` from the Result branch instead of throwing a
        // confusing "Goal objective is required." error from
        // setGoalImmediately when `current === null`
        // (Coder-agents-review P3 DEREM-20).
        ...(expectedGoalId != null ? { expectedGoalId } : {}),
      });
      if (!result.success) {
        throw new Error(`Failed to complete goal: ${formatGoalSetError(result.error)}`);
      }

      return { goal: result.data };
    },
  });
};
