import { describe, expect, it } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import type { AskUserQuestionToolArgs } from "@/common/types/tools";
import { isAsyncAskUserQuestionOutput } from "@/common/utils/tools/askUserQuestionSummary";
import { askUserQuestionManager } from "@/node/services/askUserQuestionManager";
import { createAskUserQuestionTool } from "./ask_user_question";
import { TestTempDir, createTestToolConfig } from "./testHelpers";

const args: AskUserQuestionToolArgs = {
  questions: [
    {
      header: "Choice",
      question: "Which option?",
      options: [
        { label: "First", description: "Use first" },
        { label: "Second", description: "Use second" },
      ],
      multiSelect: false,
    },
  ],
};

function toolOptions(toolCallId: string): ToolExecutionOptions<unknown> {
  return { toolCallId, messages: [], context: undefined };
}

describe("ask_user_question tool", () => {
  it("returns without waiting outside plan agents and stays answerable", async () => {
    using tempDir = new TestTempDir("test-ask-user-question-async");
    const workspaceId = "ws-ask-async";
    const tool = createAskUserQuestionTool(createTestToolConfig(tempDir.path, { workspaceId }));

    const result: unknown = await Promise.resolve(tool.execute!(args, toolOptions("ask-async")));

    expect(isAsyncAskUserQuestionOutput(result)).toBe(true);
    // Nothing blocks on the user: there is no pending (blocking) entry to answer or cancel.
    expect(askUserQuestionManager.getLatestPending(workspaceId)).toBeNull();
  });

  it("still waits for the answers in plan agents", async () => {
    using tempDir = new TestTempDir("test-ask-user-question-plan");
    const workspaceId = "ws-ask-plan";
    const tool = createAskUserQuestionTool({
      ...createTestToolConfig(tempDir.path, { workspaceId }),
      planFileOnly: true,
    });

    const resultPromise = Promise.resolve(tool.execute!(args, toolOptions("ask-plan")));
    expect(askUserQuestionManager.getLatestPending(workspaceId)?.toolCallId).toBe("ask-plan");

    askUserQuestionManager.answer(workspaceId, "ask-plan", { "Which option?": "First" });
    const result: unknown = await resultPromise;

    expect(isAsyncAskUserQuestionOutput(result)).toBe(false);
    expect(result).toMatchObject({
      ui_only: { ask_user_question: { answers: { "Which option?": "First" } } },
    });
  });
});
