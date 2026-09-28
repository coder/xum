import { tool } from "ai";
import assert from "@/common/utils/assert";
import type { ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { DEFAULT_GOAL_DEFAULTS } from "@/constants/goals";
import { resolveModelGoalSetIntent } from "@/common/utils/goals/resolveGoalSetIntent";
import type { GoalRecordV1 } from "@/common/types/goal";
import { formatGoalSetError } from "./goalErrors";

function assertResolvedModelGoalBounds(goal: Pick<GoalRecordV1, "budgetCents" | "turnCap">): void {
  assert(
    goal.budgetCents == null || (Number.isInteger(goal.budgetCents) && goal.budgetCents > 0),
    "set_goal resolved budget must be a positive integer or null"
  );
  assert(
    goal.turnCap == null || (Number.isInteger(goal.turnCap) && goal.turnCap > 0),
    "set_goal resolved turn cap must be a positive integer or null"
  );
}

export const createSetGoalTool: ToolFactory = (config) => {
  return tool({
    description: TOOL_DEFINITIONS.set_goal.description,
    inputSchema: TOOL_DEFINITIONS.set_goal.schema,
    execute: async ({ objective, budgetCents, turnCap, replaceExistingGoal, expectedGoalId }) => {
      assert(config.workspaceId, "set_goal requires workspaceId");
      assert(config.goalService, "set_goal requires goalService");

      const trimmedObjective = objective.trim();
      assert(trimmedObjective.length > 0, "set_goal requires a non-empty objective");
      const defaults = config.goalDefaults ?? DEFAULT_GOAL_DEFAULTS;
      const resolved = resolveModelGoalSetIntent(
        {
          objective: trimmedObjective,
          budgetCents: budgetCents ?? null,
          turnCap: turnCap ?? null,
        },
        defaults
      );

      assert(resolved.objective.length > 0, "set_goal resolved objective must be non-empty");
      assertResolvedModelGoalBounds(resolved);
      if (resolved.budgetCents == null && resolved.turnCap == null) {
        throw new Error(
          "set_goal requires a budget or turn cap for model-created goals. Ask the user to provide one, or configure a positive effective default goal budget/turn cap."
        );
      }

      const result = await config.goalService.setGoal({
        workspaceId: config.workspaceId,
        objective: resolved.objective,
        status: "active",
        budgetCents: resolved.budgetCents,
        turnCap: resolved.turnCap,
        initiator: "model",
        forceNewGoal: true,
        replacementGuard: {
          replaceExistingGoal: replaceExistingGoal ?? null,
          expectedGoalId: expectedGoalId ?? null,
        },
        ...(expectedGoalId != null ? { expectedGoalId } : {}),
        ...(config.goalKickoffModel != null ? { kickoffModel: config.goalKickoffModel } : {}),
      });
      if (!result.success) {
        throw new Error(`Failed to set goal: ${formatGoalSetError(result.error)}`);
      }

      return { goal: result.data };
    },
  });
};
