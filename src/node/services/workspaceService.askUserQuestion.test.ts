import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { createMuxMessage } from "@/common/types/message";
import { Ok } from "@/common/types/result";
import { ASK_USER_QUESTION_ASYNC_SUMMARY } from "@/common/utils/tools/askUserQuestionSummary";
import { askUserQuestionManager } from "./askUserQuestionManager";
import {
  createWorkspaceServiceHarness,
  type WorkspaceServiceHarness,
} from "./workspaceService.testHarness";

const workspaceId = "ws-async-question";
const toolCallId = "ask-async";
const answers = { "Which option?": "First" };
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

/** Assistant row holding a non-blocking question, as committed after the tool returned. */
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
    askUserQuestionManager.deleteAsync(workspaceId, toolCallId);
    await harness.cleanup();
  });

  test("sends the answers as a steering message for the next step", async () => {
    const send = spyOn(harness.service, "sendMessage").mockResolvedValue(Ok(undefined));
    askUserQuestionManager.registerAsync(workspaceId, toolCallId);

    expect(await harness.service.answerAskUserQuestion(workspaceId, toolCallId, answers)).toEqual(
      Ok(undefined)
    );

    expect(send).toHaveBeenCalledTimes(1);
    const [, , options, internal] = send.mock.calls[0];
    expect(options.queueDispatchMode).toBe("tool-end");
    expect(options.muxMetadata).toMatchObject({ askUserQuestionAnswer: { toolCallId, answers } });
    expect(internal?.queueDedupeKey).toContain(toolCallId);
    expect(askUserQuestionManager.hasAsync(workspaceId, toolCallId)).toBe(false);
  });

  test("after a restart, finds the question in history and refuses a second answer", async () => {
    const send = spyOn(harness.service, "sendMessage").mockResolvedValue(Ok(undefined));
    await harness.historyService.appendToHistory(workspaceId, asyncQuestionMessage());

    expect(await harness.service.answerAskUserQuestion(workspaceId, toolCallId, answers)).toEqual(
      Ok(undefined)
    );
    expect(send).toHaveBeenCalledTimes(1);
    // The question row stays as the tool returned it: answers live only in the answer message.
    const history = await harness.historyService.getLastMessages(workspaceId, 1);
    expect(history.success && history.data[0].parts[0]).toMatchObject({
      state: "output-available",
    });

    await harness.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("answer", "user", "answers", {
        muxMetadata: { type: "normal", askUserQuestionAnswer: { toolCallId, answers } },
      })
    );
    const repeat = await harness.service.answerAskUserQuestion(workspaceId, toolCallId, answers);
    expect(repeat.success).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
