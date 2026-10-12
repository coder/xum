import { describe, expect, test } from "bun:test";

import type { AskUserQuestionQuestion } from "@/common/types/tools";
import { buildAskUserQuestionAnswerMessage } from "./askUserQuestionSummary";

const multi: AskUserQuestionQuestion = {
  header: "Targets",
  question: "Which targets?",
  options: [
    { label: "Linux, x64", description: "a" },
    { label: "macOS", description: "b" },
    { label: "Windows", description: "c" },
  ],
  multiSelect: true,
};
const single: AskUserQuestionQuestion = {
  header: "Mode",
  question: "Which mode?",
  options: [
    { label: "Fast", description: "a" },
    { label: "Safe", description: "b" },
  ],
  multiSelect: false,
};

describe("buildAskUserQuestionAnswerMessage", () => {
  test("maps labels (including ones with commas) to numbers and keeps only typed text", () => {
    const text = buildAskUserQuestionAnswerMessage("call-1", [multi, single], {
      "Which targets?": "Linux, x64, Windows, also BSD",
      "Which mode?": "",
    });

    expect(text).toContain('- Question 1: options 1, 3; other: "also BSD"');
    expect(text).toContain("- Question 2: skipped");
    // Labels are model-authored: none of them may appear in the user-role text.
    for (const label of ["Linux", "macOS", "Windows", "Fast", "Safe"]) {
      expect(text).not.toContain(label);
    }
  });

  test("treats an unmatched single-select answer as the user's own text", () => {
    const text = buildAskUserQuestionAnswerMessage("call-1", [single], {
      "Which mode?": "Balanced",
    });

    expect(text).toContain('- Question 1: other: "Balanced"');
  });
});
