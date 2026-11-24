import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TaskRemoveToolResultSchema, TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { LossyWorkPolicy } from "@/node/services/taskService";
import {
  dedupeStrings,
  parseToolResult,
  requireTaskService,
  requireWorkspaceId,
} from "./toolUtils";

/** Only `force: true` forces: false, null (strict-mode providers) and an omitted flag refuse. */
function lossyWorkPolicyFor(force: boolean | null | undefined): LossyWorkPolicy {
  return force === true ? "force" : "refuse";
}

export const createTaskRemoveTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.task_remove.description,
    inputSchema: TOOL_DEFINITIONS.task_remove.schema,
    execute: async (args): Promise<unknown> => {
      if (config.planFileOnly === true) {
        throw new Error("task_remove is not available in plan mode");
      }

      const ownerWorkspaceId = requireWorkspaceId(config, "task_remove");
      const taskService = requireTaskService(config, "task_remove");
      const taskIds = dedupeStrings(args.task_ids);
      const depths = new Map(
        taskService
          .listDescendantAgentTasks(ownerWorkspaceId)
          .map((task) => [task.taskId, task.depth] as const)
      );
      taskIds.sort((left, right) => (depths.get(right) ?? 0) - (depths.get(left) ?? 0));

      const results = [];
      for (const taskId of taskIds) {
        // The model's decision is not user consent: refuse removals that would lose work (#4723),
        // unless the call sets `force`, which deletes that work and reports it on the result.
        const result = await taskService.removeInactiveDescendantAgentTask(
          ownerWorkspaceId,
          taskId,
          { lossyWorkPolicy: lossyWorkPolicyFor(args.force) }
        );
        if (!result.success) {
          results.push({ status: "error" as const, taskId, error: result.error });
          continue;
        }
        const data = result.data;
        switch (data.status) {
          case "removed":
          case "already_removed":
          case "active":
          case "not_found":
          case "invalid_scope":
            results.push({
              status: data.status,
              taskId,
              ...(data.workspaceId != null ? { workspaceId: data.workspaceId } : {}),
              // Only a forced removal sets these; otherwise they are undefined and leave the JSON.
              deletedWork: data.deletedWork,
              paths: data.paths,
            });
            break;
          case "error":
            results.push({
              status: "error" as const,
              taskId,
              ...(data.workspaceId != null ? { workspaceId: data.workspaceId } : {}),
              ...(data.descendantTaskIds != null
                ? { descendantTaskIds: data.descendantTaskIds }
                : {}),
              ...(data.paths != null ? { paths: data.paths } : {}),
              // A forced removal that failed part-way reports what it may have deleted.
              deletedWork: data.deletedWork,
              error: data.error ?? "Task removal failed.",
            });
            break;
          default:
            results.push({
              status: "error" as const,
              taskId,
              error: `Task cannot be removed from lifecycle state ${data.status}.`,
            });
        }
      }

      return parseToolResult(TaskRemoveToolResultSchema, { results }, "task_remove");
    },
  });
};
