import { describe, expect, test } from "bun:test";

import type { DisplayedMessage } from "@/common/types/message";
import { findOpenAskUserQuestions } from "@/browser/utils/messages/openAskUserQuestions";
import {
  getTranscriptAskUserQuestionPlacement,
  NO_DOCKED_QUESTIONS,
  reconcileDockedQuestionIds,
  releaseDockedQuestionId,
} from "./askUserQuestionPlacement";

const ASYNC_RESULT = {
  summary: "Questions shown to the user.",
  ui_only: { ask_user_question: { questions: [], answers: {}, answerDelivery: "message" } },
};

const VALID_ARGS = {
  questions: [
    {
      question: "Which option?",
      header: "Option",
      options: [
        { label: "First", description: "The first option." },
        { label: "Second", description: "The second option." },
      ],
      multiSelect: false,
    },
  ],
};

function question(
  toolCallId: string,
  overrides: Partial<DisplayedMessage & { type: "tool" }> = {}
): DisplayedMessage & { type: "tool" } {
  return {
    type: "tool",
    id: `row-${toolCallId}`,
    historyId: `history-${toolCallId}`,
    toolCallId,
    toolName: "ask_user_question",
    args: VALID_ARGS,
    status: "completed",
    isPartial: false,
    historySequence: 1,
    ...overrides,
  };
}

function answer(toolCallId: string): DisplayedMessage {
  return {
    type: "user",
    id: `answer-${toolCallId}`,
    historyId: `history-answer-${toolCallId}`,
    content: "option 1",
    historySequence: 2,
    askUserQuestionAnswers: [{ toolCallId, answers: {} }],
  };
}

const BOUNDARY: DisplayedMessage = {
  type: "compaction-boundary",
  id: "boundary",
  historySequence: 3,
  position: "start",
};

function openIds(messages: DisplayedMessage[]): string[] {
  return findOpenAskUserQuestions("ws", messages).map((message) => message.toolCallId);
}

describe("findOpenAskUserQuestions", () => {
  test("a blocking question is open only while its tool call executes", () => {
    expect(openIds([question("waiting", { status: "executing" })])).toEqual(["waiting"]);
    expect(openIds([question("answered", { result: { answers: {} } })])).toEqual([]);
  });

  test("a non-blocking question stays open until an answer row for it lands", () => {
    const asked = question("async", { result: ASYNC_RESULT });
    expect(openIds([asked])).toEqual(["async"]);
    expect(openIds([asked, answer("async")])).toEqual([]);
    // An answer to another question does not close this one.
    expect(openIds([asked, answer("other")])).toEqual(["async"]);
  });

  test("a non-blocking question closes once a later boundary drops it from context", () => {
    const asked = question("async", { result: ASYNC_RESULT });
    expect(openIds([asked, BOUNDARY])).toEqual([]);
    expect(openIds([BOUNDARY, asked])).toEqual(["async"]);
  });

  test("the transcript stubs open questions unless the workspace has no composer", () => {
    const docked = (transcriptOnly: boolean) => {
      const placement = getTranscriptAskUserQuestionPlacement({
        workspaceId: "ws",
        transcriptOnly,
        // The deferred snapshot still has the question open after the immediate one closed it.
        transcripts: [
          [question("q", { result: { answers: {} } })],
          [question("q", { status: "executing" })],
        ],
      });
      return placement.kind === "transcript" ? [...placement.dockedRowIds] : [];
    };
    expect(docked(false)).toEqual(["row-q"]);
    expect(docked(true)).toEqual([]);
  });

  test("leaves rows with malformed args, which render as the generic card, in the transcript", () => {
    expect(openIds([question("bad", { status: "executing", args: { questions: [] } })])).toEqual(
      []
    );
  });

  test("of rows that reuse a tool call id, only the latest can be open", () => {
    const older = question("reused", { id: "row-old", result: ASYNC_RESULT });
    const newer = question("reused", { id: "row-new", result: ASYNC_RESULT });
    const rowIds = (messages: DisplayedMessage[]) =>
      findOpenAskUserQuestions("ws", messages).map((message) => message.id);
    expect(rowIds([older, newer])).toEqual(["row-new"]);
    // A boundary between them drops only the older row from context.
    expect(rowIds([older, BOUNDARY, newer])).toEqual(["row-new"]);
    // A closed newer row still replaces the older one.
    expect(rowIds([older, question("reused", { id: "row-new", result: { answers: {} } })])).toEqual(
      []
    );
  });

  test("ignores other tools and keeps transcript order", () => {
    const messages: DisplayedMessage[] = [
      question("first", { status: "executing" }),
      question("bash", { toolName: "bash", status: "executing" }),
      question("second", { result: ASYNC_RESULT }),
    ];
    expect(openIds(messages)).toEqual(["first", "second"]);
  });
});

describe("docked question ids", () => {
  test("a closed card stays docked until it releases itself", () => {
    const opened = reconcileDockedQuestionIds(NO_DOCKED_QUESTIONS, ["q"]);
    expect(opened).toEqual(["q"]);
    // The transcript closed the question; the card still finishes its rollback.
    expect(reconcileDockedQuestionIds(opened, [])).toBe(opened);
    expect(releaseDockedQuestionId(opened, "q")).toEqual([]);
  });
});
