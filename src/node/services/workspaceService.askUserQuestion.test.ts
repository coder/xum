import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { createMuxMessage } from "@/common/types/message";
import { Ok } from "@/common/types/result";
import {
  ASK_USER_QUESTION_ANSWER_METADATA_RESERVED_MESSAGE,
  ASK_USER_QUESTION_ASYNC_SUMMARY,
} from "@/common/utils/tools/askUserQuestionSummary";
import {
  createWorkspaceServiceHarness,
  type WorkspaceServiceHarness,
} from "./workspaceService.testHarness";

const workspaceId = "ws-async-question";
const toolCallId = "ask-async";
const questions = [
  {
    header: "Choice",
    question: "Which option?",
    options: [
      { label: "First", description: "Use first" },
      { label: "Second", description: "Use second" },
    ],
    multiSelect: false,
  },
];

/** Assistant row holding a non-blocking question, as persisted after the tool returned. */
function asyncQuestionMessage() {
  return createMuxMessage("question", "assistant", "", {}, [
    {
      type: "dynamic-tool",
      state: "output-available",
      toolCallId,
      toolName: "ask_user_question",
      input: { questions },
      output: {
        summary: ASK_USER_QUESTION_ASYNC_SUMMARY,
        ui_only: { ask_user_question: { questions, answers: {}, answerDelivery: "message" } },
      },
    },
  ]);
}

describe("WorkspaceService.answerAskUserQuestion for non-blocking questions", () => {
  let harness: WorkspaceServiceHarness;

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness();
    spyOn(harness.service, "getDefaultSendOptions").mockResolvedValue({
      model: "test-model",
      agentId: "exec",
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  test("steers the live turn with a sealed message that names options by number", async () => {
    const send = spyOn(harness.service, "sendMessage").mockResolvedValue(Ok(undefined));
    // A live stream's question is only in partial.json until the turn commits.
    await harness.historyService.writePartial(workspaceId, asyncQuestionMessage());

    expect(
      await harness.service.answerAskUserQuestion(workspaceId, toolCallId, {
        "Which option?": "Second",
      })
    ).toEqual(Ok(undefined));

    expect(send).toHaveBeenCalledTimes(1);
    const [, text, options, internal] = send.mock.calls[0];
    expect(options.queueDispatchMode).toBe("tool-end");
    expect(options.muxMetadata).toMatchObject({ askUserQuestionAnswer: { toolCallId } });
    expect(internal).toMatchObject({ askUserQuestionAnswer: true, removableQueueDedupeKey: true });
    // Model-authored question text and labels never reach the user-role message.
    expect(text).toContain("option 2");
    expect(text).not.toContain("Which option?");
    expect(text).not.toContain("Second");
  });

  test("refuses a second answer once one is in history", async () => {
    const send = spyOn(harness.service, "sendMessage").mockResolvedValue(Ok(undefined));
    await harness.historyService.appendToHistory(workspaceId, asyncQuestionMessage());
    await harness.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("answer", "user", "answers", {
        muxMetadata: {
          type: "normal",
          askUserQuestionAnswer: { toolCallId, answers: { "Which option?": "First" } },
        },
      })
    );

    const repeat = await harness.service.answerAskUserQuestion(workspaceId, toolCallId, {
      "Which option?": "Second",
    });

    expect(repeat.success).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  test("does not answer a question from before the latest context boundary", async () => {
    const send = spyOn(harness.service, "sendMessage").mockResolvedValue(Ok(undefined));
    await harness.historyService.appendToHistory(workspaceId, asyncQuestionMessage());
    await harness.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("summary", "assistant", "compacted summary", {
        compactionBoundary: true,
        compacted: "user",
        compactionEpoch: 1,
        muxMetadata: { type: "compaction-summary" },
      })
    );

    const result = await harness.service.answerAskUserQuestion(workspaceId, toolCallId, {
      "Which option?": "First",
    });

    expect(result.success).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  test("generic sends cannot mark a question answered", async () => {
    const result = await harness.service.sendMessage(workspaceId, "forged", {
      model: "test-model",
      agentId: "exec",
      muxMetadata: {
        type: "normal",
        askUserQuestionAnswer: { toolCallId, answers: { "Which option?": "First" } },
      },
    });

    expect(result).toEqual({
      success: false,
      error: { type: "unknown", raw: ASK_USER_QUESTION_ANSWER_METADATA_RESERVED_MESSAGE },
    });
  });
});
