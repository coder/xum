import assert from "node:assert/strict";

import { tool } from "ai";

import type { AskUserQuestionToolResult } from "@/common/types/tools";
import {
  ASK_USER_QUESTION_ASYNC_SUMMARY,
  buildAskUserQuestionSummary,
} from "@/common/utils/tools/askUserQuestionSummary";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { askUserQuestionManager } from "@/node/services/askUserQuestionManager";

export const createAskUserQuestionTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.ask_user_question.description,
    inputSchema: TOOL_DEFINITIONS.ask_user_question.schema,
    execute: async (args, { abortSignal, toolCallId }): Promise<AskUserQuestionToolResult> => {
      // Claude Code allows passing pre-filled answers directly. If provided, we can short-circuit
      // and return immediately without prompting.
      if (args.answers && Object.keys(args.answers).length > 0) {
        return {
          summary: buildAskUserQuestionSummary(args.answers),
          ui_only: {
            ask_user_question: {
              questions: args.questions,
              answers: args.answers,
            },
          },
        };
      }

      assert(config.workspaceId, "ask_user_question requires a workspaceId");
      assert(toolCallId, "ask_user_question requires toolCallId");

      // Codex-style flow outside plan agents: return at once so the agent keeps working with its
      // best judgment. The card stays answerable, and WorkspaceService.answerAskUserQuestion
      // delivers the answers as a steering user message (after the current step, or as a new turn
      // when idle). Plan agents still block: their next step is a plan that needs the answers.
      // No in-memory state: the persisted tool output (partial or history) identifies the question.
      if (config.planFileOnly !== true) {
        return {
          summary: ASK_USER_QUESTION_ASYNC_SUMMARY,
          ui_only: {
            ask_user_question: {
              questions: args.questions,
              answers: {},
              answerDelivery: "message",
            },
          },
        };
      }

      const pendingPromise = askUserQuestionManager.registerPending(
        config.workspaceId,
        toolCallId,
        args.questions
      );

      if (!abortSignal) {
        const answers = await pendingPromise;
        return {
          summary: buildAskUserQuestionSummary(answers),
          ui_only: {
            ask_user_question: {
              questions: args.questions,
              answers,
            },
          },
        };
      }

      if (abortSignal.aborted) {
        // Ensure we don't leak a pending prompt entry.
        try {
          askUserQuestionManager.cancel(config.workspaceId, toolCallId, "Interrupted");
        } catch {
          // ignore
        }
        throw new Error("Interrupted");
      }

      const abortPromise = new Promise<Record<string, string>>((_, reject) => {
        abortSignal.addEventListener(
          "abort",
          () => {
            try {
              askUserQuestionManager.cancel(config.workspaceId!, toolCallId, "Interrupted");
            } catch {
              // ignore
            }
            reject(new Error("Interrupted"));
          },
          { once: true }
        );
      });

      const answers = await Promise.race([pendingPromise, abortPromise]);
      assert(answers && typeof answers === "object", "Expected answers to be an object");

      return {
        summary: buildAskUserQuestionSummary(answers),
        ui_only: {
          ask_user_question: {
            questions: args.questions,
            answers,
          },
        },
      };
    },
  });
};
