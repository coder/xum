import { tool } from "ai";
import type { z } from "zod";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";

export type NewContextResult = z.infer<typeof TOOL_DEFINITIONS.new_context.resultSchema>;

/**
 * Model-requested context rollover. The tool itself is pure: its persisted successful result is
 * the durable request receipt. StreamManager reports it to AgentSession once every sibling tool
 * result of the step has settled (`SettledStepBudget.newContextRequested`), which schedules the
 * same rollover continuation the automatic token budget uses; on restart, AgentSession recovers
 * an unconsumed receipt from the current window's last completed assistant message.
 */
export const createNewContextTool: ToolFactory = (config: ToolConfiguration) =>
  tool({
    description: TOOL_DEFINITIONS.new_context.description,
    inputSchema: TOOL_DEFINITIONS.new_context.schema,
    execute: (): Promise<NewContextResult> =>
      Promise.resolve(
        // The tool is registered even while auto-compaction at 100% disables
        // rollover, so a settings edit does not change the tool block (prompt
        // cache, #5249). Refuse then: a successful result is a durable receipt
        // that a later send would honor once rollover is re-enabled.
        config.contextBudgetRolloverAvailable === false
          ? {
              success: false,
              code: "rollover_disabled",
              error:
                "Automatic rollover is disabled (auto-compaction threshold 100%), so no new context window can start. Continue in this window.",
            }
          : {
              success: true,
              status: "scheduled",
              message: "A new context window will start without summarizing conversation history.",
            }
      ),
  });
