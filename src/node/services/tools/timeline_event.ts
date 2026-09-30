import { tool } from "ai";
import assert from "@/common/utils/assert";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolFactory } from "@/common/utils/tools/tools";

export const createTimelineEventTool: ToolFactory = (config) =>
  tool({
    description: TOOL_DEFINITIONS.timeline_event.description,
    inputSchema: TOOL_DEFINITIONS.timeline_event.schema,
    execute: ({ description, category }, options) => {
      assert(config.workspaceId, "timeline_event requires workspaceId");
      assert(config.timelineService, "timeline_event requires timelineService");

      const normalizedDescription = description.trim();
      assert(normalizedDescription.length > 0, "timeline_event requires a non-empty description");

      const recorded = config.timelineService.recordAgentEvent(config.workspaceId, {
        description: normalizedDescription,
        ...(category != null ? { category } : {}),
        toolCallId: options.toolCallId,
      });

      return { success: true as const, recorded };
    },
  });
