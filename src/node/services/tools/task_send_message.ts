import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import {
  TaskSendMessageToolResultSchema,
  TOOL_DEFINITIONS,
} from "@/common/utils/tools/toolDefinitions";
import type { AgentTreeTargetRelation } from "@/node/services/taskService";

import { parseToolResult, requireTaskService, requireWorkspaceId } from "./toolUtils";

const TARGET_RELATION_LABELS: Record<
  AgentTreeTargetRelation,
  ReturnType<typeof targetRelationLabel>
> = {
  target_descendant: "descendant",
  target_ancestor: "ancestor",
  peer: "sibling",
  // Cross-tree targets still take the untrusted envelope path, exactly like siblings.
  target_unrelated: "unrelated",
  target_main_chat: "main_chat",
  target_side_chat: "side_chat",
};

/** Routing relation → the target's relation to the sender, as shown in tool results. */
function targetRelationLabel(
  relation: AgentTreeTargetRelation
): "descendant" | "ancestor" | "sibling" | "unrelated" | "main_chat" | "side_chat" {
  return TARGET_RELATION_LABELS[relation];
}

export const createTaskSendMessageTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.task_send_message.description,
    inputSchema: TOOL_DEFINITIONS.task_send_message.schema,
    execute: async (args): Promise<unknown> => {
      const workspaceId = requireWorkspaceId(config, "task_send_message");
      const taskService = requireTaskService(config, "task_send_message");

      // The default dispatch mode depends on the target's relation (ancestors default to
      // turn-end), which only the service can compute — pass the raw arg through.
      const result = await taskService.sendAgentTreeMessage(
        workspaceId,
        args.task_id,
        args.message,
        args.queue_dispatch_mode ?? undefined
      );

      if (result.success) {
        const targetRelation = targetRelationLabel(result.data.relation);
        return parseToolResult(
          TaskSendMessageToolResultSchema,
          result.data.delivery === "accepted"
            ? { status: "accepted", taskId: args.task_id, targetRelation }
            : result.data.delivery === "reactivated"
              ? { status: "reactivated", taskId: args.task_id }
              : {
                  status: "queued",
                  taskId: args.task_id,
                  targetRelation,
                  ...(result.data.queueDispatchMode != null
                    ? { queueDispatchMode: result.data.queueDispatchMode }
                    : {}),
                  ...(result.data.awaitsDelegatedTurn === true
                    ? { awaitsDelegatedTurn: true as const }
                    : {}),
                },
          "task_send_message"
        );
      }

      const error = result.error;
      const toolResult =
        error.code === "not_found"
          ? { status: "not_found" as const, taskId: args.task_id }
          : error.code === "invalid_scope"
            ? { status: "invalid_scope" as const, taskId: args.task_id }
            : error.code === "not_active"
              ? {
                  status: "not_active" as const,
                  taskId: args.task_id,
                  taskStatus: error.taskStatus,
                  error: error.message ?? `Task is ${error.taskStatus} and cannot accept messages.`,
                }
              : error.code === "refused"
                ? { status: "refused" as const, taskId: args.task_id, reason: error.reason }
                : error.code === "rate_limited"
                  ? {
                      status: "rate_limited" as const,
                      taskId: args.task_id,
                      ...(error.retryAfterMs != null
                        ? { retryAfterMs: Math.ceil(error.retryAfterMs) }
                        : {}),
                    }
                  : { status: "error" as const, taskId: args.task_id, error: error.message };

      return parseToolResult(TaskSendMessageToolResultSchema, toolResult, "task_send_message");
    },
  });
};
