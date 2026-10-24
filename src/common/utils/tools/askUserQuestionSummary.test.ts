import { describe, expect, test } from "bun:test";

import {
  buildAskUserQuestionAnswerMessage,
  getAskUserQuestionOccurrenceState,
  getAskUserQuestionOccurrences,
  type AskUserQuestionOccurrenceState,
  type AskUserQuestionTranscriptRow,
} from "./askUserQuestionSummary";

describe("buildAskUserQuestionAnswerMessage", () => {
  test("numbers each question and marks unanswered ones skipped", () => {
    const text = buildAskUserQuestionAnswerMessage("call-1", [
      { optionNumbers: [1, 3], otherText: "  also BSD " },
      { optionNumbers: [], otherText: "" },
      { optionNumbers: [2], otherText: "" },
    ]);

    expect(text).toContain("tool call call-1");
    expect(text).toContain('- Question 1: options 1, 3; other: "also BSD"');
    expect(text).toContain("- Question 2: skipped");
    expect(text).toContain("- Question 3: option 2");
  });
});

describe("ask_user_question occurrences", () => {
  const question = (id: string, toolCallId = "call_0") => ({
    type: "tool",
    id,
    toolName: "ask_user_question",
    toolCallId,
  });
  const answer = (choice: string, toolCallId = "call_0") => ({
    type: "user",
    askUserQuestionAnswers: [{ toolCallId, answers: { "Which?": choice } }],
  });
  const states = (
    transcript: readonly AskUserQuestionTranscriptRow[]
  ): Record<string, AskUserQuestionOccurrenceState> => {
    const byRowId: Record<string, AskUserQuestionOccurrenceState> = {};
    for (const occurrence of getAskUserQuestionOccurrences(transcript)) {
      byRowId[occurrence.row.id ?? ""] = occurrence.state;
    }
    return byRowId;
  };

  test("an answer belongs to the latest earlier row with its id; a later row supersedes", () => {
    // A provider that numbers its calls per turn reuses call_0.
    const result = states([
      question("row-1"),
      answer("A"),
      question("row-2"),
      answer("B"),
      question("row-3"),
    ]);
    expect(result["row-1"]).toEqual({
      answers: { "Which?": "A" },
      superseded: true,
      leftContext: false,
    });
    expect(result["row-2"]).toEqual({
      answers: { "Which?": "B" },
      superseded: true,
      leftContext: false,
    });
    // Only the latest row takes answers; the agent reads an answer to call_0 as meant for it.
    expect(result["row-3"]).toEqual({ answers: undefined, superseded: false, leftContext: false });
  });

  test("a later correction wins, and other tools or ids do not interfere", () => {
    const result = states([
      question("row-1"),
      question("other", "call_1"),
      { type: "tool", id: "bash", toolName: "bash", toolCallId: "call_0" },
      answer("A"),
      answer("B"),
    ]);
    expect(result["row-1"]).toEqual({
      answers: { "Which?": "B" },
      superseded: false,
      leftContext: false,
    });
    expect(result.other.answers).toBeUndefined();
  });

  test("a boundary closes only the rows before it", () => {
    const result = states([
      question("row-1"),
      { type: "compaction-boundary" },
      question("row-2", "call_1"),
    ]);
    expect(result["row-1"].leftContext).toBe(true);
    expect(result["row-2"].leftContext).toBe(false);
  });

  test("a row is found by its display id, else by its tool call id alone", () => {
    const transcript = [question("row-1"), answer("A"), question("row-2")];
    expect(
      getAskUserQuestionOccurrenceState(transcript, { toolCallId: "call_0", rowId: "row-1" })
    ).toMatchObject({ answers: { "Which?": "A" }, superseded: true });
    // Without a row id, the latest row with the id.
    expect(getAskUserQuestionOccurrenceState(transcript, { toolCallId: "call_0" })).toMatchObject({
      answers: undefined,
      superseded: false,
    });
    // A row missing from the transcript (a host that feeds none) still sees its answer rows.
    expect(
      getAskUserQuestionOccurrenceState([answer("C")], { toolCallId: "call_0", rowId: "gone" })
    ).toEqual({ answers: { "Which?": "C" }, superseded: false, leftContext: false });
  });
});
