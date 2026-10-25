import { tool, type Tool } from "ai";
import assert from "@/common/utils/assert";
import type { StatusUpdateToolResult } from "@/common/types/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration } from "@/common/utils/tools/tools";

/** status_update needs the status page agent queue and an active status page agent mode. */
export function isStatusUpdateEnabled(config: ToolConfiguration): boolean {
  return config.statusPageAgent != null && config.statusPageAgentActive === true;
}

/** `{ status_update }` while the tool is enabled for this turn, else no tools. */
export function createStatusUpdateTools(
  config: ToolConfiguration,
  fallbackModel: string
): Record<string, Tool> {
  return isStatusUpdateEnabled(config)
    ? { status_update: createStatusUpdateTool(config, fallbackModel) }
    : {};
}

/**
 * status_update (status page agent mode): queues the update for the host-run status page agent
 * and returns at once, so the main loop never waits for the page edit. `fallbackModel` is this
 * turn's model, used when no Status Page model is configured in Settings > Agents.
 */
function createStatusUpdateTool(config: ToolConfiguration, fallbackModel: string): Tool {
  return tool({
    description: TOOL_DEFINITIONS.status_update.description,
    inputSchema: TOOL_DEFINITIONS.status_update.schema,
    execute: ({ update }): StatusUpdateToolResult => {
      assert(config.workspaceId, "status_update requires workspaceId");
      assert(config.statusPageAgent, "status_update requires the status page agent queue");
      const text = update.trim();
      if (text.length === 0) return { success: false, error: "update must not be empty" };

      const result = config.statusPageAgent.enqueue(config.workspaceId, {
        update: text,
        fallbackModel,
      });
      if (result.previousError === undefined) return { success: true, queued: true };
      // Provider messages often end with a period already.
      const error = result.previousError.replace(/[\s.]+$/, "");
      return {
        success: true,
        queued: true,
        note: `The status page agent's last update failed: ${error}. Its updates are retried with this one, but the page may be out of date; edit it yourself if this keeps happening.`,
      };
    },
  });
}
