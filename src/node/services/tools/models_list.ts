import { tool } from "ai";

import type { ModelsListToolArgs, ModelsListToolResult } from "@/common/types/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { log } from "@/node/services/log";

/** Returned where no backend catalog closure exists (test contexts, refinement). */
export const MODELS_LIST_UNAVAILABLE_ERROR = "Model catalog unavailable in this context";
/**
 * Fixed text on a throwing closure: exception messages could echo configuration
 * (provider names, base URLs), so they are logged on the Node side and never
 * returned to the model.
 */
export const MODELS_LIST_FAILED_ERROR = "Failed to compute the model catalog";

/**
 * Read-only discovery of the model IDs / aliases / thinking levels the `task`
 * tool accepts under the current configuration. The list is advisory (a
 * configuration snapshot, not a provider probe); send-time validation stays
 * authoritative and `task.model` still accepts any well-formed string.
 */
export const createModelsListTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.models_list.description,
    inputSchema: TOOL_DEFINITIONS.models_list.schema,
    // Synchronous on purpose: the closure reads in-memory config snapshots; no I/O.
    execute: (_args: ModelsListToolArgs): ModelsListToolResult => {
      const listAvailableModels = config.listAvailableModels;
      if (listAvailableModels == null) {
        return { success: false, error: MODELS_LIST_UNAVAILABLE_ERROR };
      }

      try {
        // An initialized configuration with nothing selectable yields models: [] (still success).
        return { success: true, models: listAvailableModels() };
      } catch (error) {
        log.error("[models_list] failed to compute the model catalog", { error });
        return { success: false, error: MODELS_LIST_FAILED_ERROR };
      }
    },
  });
};
