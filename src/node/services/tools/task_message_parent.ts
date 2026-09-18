import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import {
  TaskMessageParentToolResultSchema,
  TOOL_DEFINITIONS,
} from "@/common/utils/tools/toolDefinitions";

import { contextProjectSkillContentWithheld } from "./projectSkillContentGate";
import { TASK_MESSAGE_PROJECT_SKILL_CONTENT_WITHHELD_ERROR } from "./task_send_message";
import { parseToolResult, requireTaskService, requireWorkspaceId } from "./toolUtils";

/**
 * RLM family messaging: child -> parent. Only registered for sub-agent sessions whose
 * task record was stamped with the rlm experiment at spawn (see aiService gating).
 */
export const createTaskMessageParentTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.task_message_parent.description,
    inputSchema: TOOL_DEFINITIONS.task_message_parent.schema,
    execute: async (args): Promise<unknown> => {
      const workspaceId = requireWorkspaceId(config, "task_message_parent");
      const taskService = requireTaskService(config, "task_message_parent");

      // The parent's request is outside this turn's consent gate (see
      // contextProjectSkillContentWithheld). Under trust the forwarded text can
      // restate project skill content this turn's context holds: the target
      // rows are stamped so the parent's own provenance tracking inherits it.
      if (await contextProjectSkillContentWithheld(config)) {
        throw new Error(TASK_MESSAGE_PROJECT_SKILL_CONTENT_WITHHELD_ERROR);
      }
      const contextCarriesProjectSkillContent =
        config.memoryWriteCarriesProjectSkillContent === true ||
        config.projectSkillContentInContext?.() === true;

      // Family messages default to tool-end dispatch so a busy parent picks them up at
      // its next tool boundary (matches task_send_message's default toward children).
      const result = contextCarriesProjectSkillContent
        ? await taskService.sendMessageToParentFromAgentTask(
            workspaceId,
            args.message,
            "tool-end",
            {
              carriesProjectSkillContent: true,
            }
          )
        : await taskService.sendMessageToParentFromAgentTask(workspaceId, args.message, "tool-end");

      const toolResult = result.success
        ? { status: "sent" as const, parentWorkspaceId: result.data.parentWorkspaceId }
        : result.error.code === "invalid_scope"
          ? { status: "invalid_scope" as const, error: result.error.message }
          : { status: "error" as const, error: result.error.message };

      return parseToolResult(TaskMessageParentToolResultSchema, toolResult, "task_message_parent");
    },
  });
};
