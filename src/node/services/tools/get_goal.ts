import { tool } from "ai";
import assert from "@/common/utils/assert";
import type { ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { getGoalToolAvailability } from "@/common/utils/tools/toolAvailability";

export const createGetGoalTool: ToolFactory = (config) => {
  return tool({
    description: TOOL_DEFINITIONS.get_goal.description,
    inputSchema: TOOL_DEFINITIONS.get_goal.schema,
    execute: async () => {
      assert(config.workspaceId, "get_goal requires workspaceId");
      assert(config.goalService, "get_goal requires goalService");
      assert(config.goalToolContext, "get_goal requires goalToolContext");

      const goal = await config.goalService.getGoal(config.workspaceId);
      // Execution-time gate (#5247): a paused or completed goal is only
      // readable when this turn may replace it with set_goal; otherwise the
      // turn has no goal available, as the tool description says.
      const { getGoal: readable } = getGoalToolAvailability({
        ...config.goalToolContext,
        goalStatus: goal?.status ?? null,
      });
      return { goal: readable ? goal : null };
    },
  });
};
