import { tool } from "ai";
import type { BashBackgroundListResult } from "@/common/types/tools";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { nodeClock } from "@/node/utils/hostClock";

/**
 * Tool for listing background processes in the current workspace
 */
export const createBashBackgroundListTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.bash_background_list.description,
    inputSchema: TOOL_DEFINITIONS.bash_background_list.schema,
    execute: async (): Promise<BashBackgroundListResult> => {
      if (!config.backgroundProcessManager) {
        return {
          success: false,
          error: "Background process manager not available",
        };
      }

      if (!config.workspaceId) {
        return {
          success: false,
          error: "Workspace ID not available",
        };
      }

      const processes = await config.backgroundProcessManager.list(config.workspaceId);
      const now = (config.clock ?? nodeClock).nowMs();

      return {
        success: true,
        processes: processes.map((p) => ({
          process_id: p.id,
          status: p.status,
          script: p.script,
          uptime_ms: p.exitTime !== undefined ? p.exitTime - p.startTime : now - p.startTime,
          exitCode: p.exitCode,
          display_name: p.displayName,
        })),
      };
    },
  });
};
