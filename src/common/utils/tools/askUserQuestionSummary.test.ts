import { describe, expect, test } from "bun:test";

import { buildAskUserQuestionAnswerMessage } from "./askUserQuestionSummary";

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
