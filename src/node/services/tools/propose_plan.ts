import { tool } from "ai";
import { z } from "zod";
import type { ToolFactory } from "@/common/utils/tools/tools";
import { completeInProgressTodoItems } from "@/common/utils/todoList";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { log } from "@/node/services/log";
import { readTodosForSessionDir } from "@/node/services/todos/todoStorage";
import { RuntimeError } from "@/node/runtime/Runtime";
import { readFileString } from "@/node/utils/runtime/helpers";
import { setTodosForSessionDir } from "./todo";

// Schema for propose_plan - empty object (no input parameters)
// Defined locally to avoid type inference issues with `as const` in TOOL_DEFINITIONS
const proposePlanSchema = z.object({});

/**
 * Propose plan tool factory for AI assistant.
 * The tool validates the plan file exists and is non-empty.
 * If the plan file doesn't exist, it returns an error instructing
 * the agent to write the plan first.
 *
 * Note: Plan content is NOT included in the tool result to save context.
 * The plan is already visible via file_edit_* diffs in history, and will be
 * included in the mode transition message when switching to exec mode.
 */
export const createProposePlanTool: ToolFactory = (config) => {
  return tool({
    description: TOOL_DEFINITIONS.propose_plan.description,
    inputSchema: proposePlanSchema,
    execute: async (_input, options) => {
      const planPath = config.planFilePath;

      if (!planPath) {
        return {
          success: false as const,
          error: "No plan file path configured. Are you in the plan agent?",
        };
      }

      // Read plan file using workspace runtime (works for both local and SSH).
      // requireRegularFile: a FIFO at the plan path would otherwise block this
      // read (and a libuv worker) indefinitely; it lands in the RuntimeError
      // branch below like any other unreadable plan.
      let planContent: string;
      try {
        planContent = await readFileString(config.runtime, planPath, undefined, {
          requireRegularFile: true,
        });
      } catch (err) {
        if (err instanceof RuntimeError) {
          return {
            success: false as const,
            error: `No plan file found at ${planPath}. Please write your plan to this file before calling propose_plan.`,
          };
        }
        throw err;
      }

      if (planContent === "") {
        return {
          success: false as const,
          error: `Plan file at ${planPath} is empty. Please write your plan content before calling propose_plan.`,
        };
      }

      // The plan-review snapshot of this proposal must hold these validated bytes, not a later
      // re-read of the (mutable) plan file.
      config.recordProposedPlan?.(options.toolCallId, planContent);

      // Record file state for external edit detection
      if (config.recordFileState) {
        try {
          const fileStat = await config.runtime.stat(planPath);
          await config.recordFileState(planPath, {
            content: planContent,
            timestamp: fileStat.modifiedTime.getTime(),
          });
        } catch {
          // File stat failed, skip recording (shouldn't happen since we just read it)
        }
      }

      if (config.workspaceId && config.workspaceSessionDir) {
        try {
          const existingTodos = await readTodosForSessionDir(config.workspaceSessionDir);
          const completedTodos = completeInProgressTodoItems(existingTodos);
          if (completedTodos !== existingTodos) {
            // A successful propose_plan ends the planning turn immediately, so persist the
            // completed todo state even though the model does not get another todo_write turn.
            await setTodosForSessionDir(
              config.workspaceId,
              config.workspaceSessionDir,
              completedTodos
            );
          }
        } catch (error) {
          // Keep propose_plan best-effort: stale todo persistence should not block plan approval.
          log.warn("propose_plan: failed to sync todo completion after successful proposal", {
            workspaceId: config.workspaceId,
            error,
          });
        }
      }

      if (config.workspaceId != null && config.timelineService != null) {
        config.timelineService.record(config.workspaceId, {
          kind: "agent.plan_proposed",
          source: { system: "agent", key: `propose-plan:${options.toolCallId}` },
          anchor: { toolCallId: options.toolCallId },
          status: "completed",
          data: { digest: planPath },
        });
      }

      return {
        success: true as const,
        planPath,
        message: "Plan proposed. Waiting for user approval.",
      };
    },
  });
};
