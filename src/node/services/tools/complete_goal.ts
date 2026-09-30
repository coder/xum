import { tool } from "ai";
import assert from "@/common/utils/assert";
import type { ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { isExecLikeEditingCapableInResolvedChain } from "@/common/utils/agentTools";
import { getGoalToolAvailability } from "@/common/utils/tools/toolAvailability";
import { completeGoalReadOnlyRefusal, formatGoalSetError, noActiveGoalRefusal } from "./goalErrors";

export const createCompleteGoalTool: ToolFactory = (config) => {
  return tool({
    description: TOOL_DEFINITIONS.complete_goal.description,
    inputSchema: TOOL_DEFINITIONS.complete_goal.schema,
    execute: async ({ summary, goalId }) => {
      assert(config.workspaceId, "complete_goal requires workspaceId");
      assert(config.goalService, "complete_goal requires goalService");
      assert(config.goalToolContext, "complete_goal requires goalToolContext");
      assert(summary.trim().length > 0, "complete_goal requires a non-empty summary");

      // Execution-time gates (#5247): the tool is registered on every turn, so
      // refuse read-only agents and calls without an active goal here with a
      // typed result. The service still re-validates the transition under its
      // lock, so a goal that changes after this read surfaces as a typed error.
      if (!isExecLikeEditingCapableInResolvedChain(config.goalToolContext.agentInheritanceChain)) {
        return completeGoalReadOnlyRefusal();
      }
      const current = await config.goalService.getGoal(config.workspaceId);
      const { completeGoal: completable } = getGoalToolAvailability({
        ...config.goalToolContext,
        goalStatus: current?.status ?? null,
      });
      if (!completable) {
        return noActiveGoalRefusal(current?.status ?? null);
      }

      const result = await config.goalService.setGoal({
        workspaceId: config.workspaceId,
        status: "complete",
        completionSummary: summary,
        initiator: "model",
        // Forward the model-provided optimistic-concurrency token so a goal
        // that was cleared or replaced mid-stream surfaces as a typed
        // `goal_conflict` from the Result branch instead of throwing a
        // confusing "Goal objective is required." error from
        // setGoalImmediately when `current === null`
        // (Coder-agents-review P3 DEREM-20).
        ...(goalId != null ? { expectedGoalId: goalId } : {}),
      });
      if (!result.success) {
        throw new Error(`Failed to complete goal: ${formatGoalSetError(result.error)}`);
      }

      return { goal: result.data };
    },
  });
};
