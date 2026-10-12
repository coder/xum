import type { AskUserQuestionAnswerMetadata } from "@/common/types/message";
import type { AskUserQuestionQuestion } from "@/common/types/tools";
import { getToolOutputUiOnly } from "@/common/utils/tools/toolOutputUiOnly";

/**
 * Model-facing result of a non-blocking ask_user_question (Codex-style): the agent keeps working
 * instead of ending its turn, and the answers arrive later as a steering user message.
 */
export const ASK_USER_QUESTION_ASYNC_SUMMARY =
  "Questions shown to the user. Do not wait for the answers and do not end your turn to wait: " +
  "continue working with your best judgment and state the assumptions you make. If the user " +
  "answers, the answers arrive later as a user message; adjust your work to them then.";

/** Generic sends that carry `muxMetadata.askUserQuestionAnswer` are refused with this. */
export const ASK_USER_QUESTION_ANSWER_METADATA_RESERVED_MESSAGE =
  "ask_user_question answer metadata is reserved for answers submitted from the question card.";

/** Queue dedupe key prefix for answer deliveries; the suffix is the tool call id. */
export const ASK_USER_QUESTION_ANSWER_DEDUPE_PREFIX = "ask-user-question-answer:";

/**
 * Splits one answer string (as built by the question card: selected labels joined with ", ",
 * then any "Other" text) into option indices and the user's own free text. Labels may contain
 * commas, so labels are matched over runs of comma-separated segments, not single tokens.
 */
function parseAnswerSelection(
  question: AskUserQuestionQuestion,
  answer: string
): { optionNumbers: number[]; otherText: string } {
  const trimmed = answer.trim();
  const labels = question.options.map((option) => option.label);
  const wholeMatch = labels.indexOf(trimmed);
  if (trimmed.length === 0 || wholeMatch !== -1) {
    return { optionNumbers: wholeMatch === -1 ? [] : [wholeMatch + 1], otherText: "" };
  }
  if (!question.multiSelect) {
    return { optionNumbers: [], otherText: trimmed };
  }

  const segments = trimmed.split(",");
  const optionNumbers: number[] = [];
  const otherSegments: string[] = [];
  let position = 0;
  while (position < segments.length) {
    const matchIndex = labels.findIndex((label) => {
      const span = label.split(",").length;
      return (
        segments
          .slice(position, position + span)
          .join(",")
          .trim() === label
      );
    });
    if (matchIndex === -1) {
      otherSegments.push(segments[position]);
      position += 1;
    } else {
      optionNumbers.push(matchIndex + 1);
      position += labels[matchIndex].split(",").length;
    }
  }
  return { optionNumbers, otherText: otherSegments.join(",").trim() };
}

/**
 * User-message text that delivers the answers to a non-blocking ask_user_question.
 *
 * SECURITY: question text and option labels are model-authored, so they must not be promoted
 * into a user-role message (repository or tool content could plant instructions in them).
 * The message refers to questions and options by number, and includes only the text the user
 * typed for "Other"; the model reads the wording from its own tool call.
 */
export function buildAskUserQuestionAnswerMessage(
  toolCallId: string,
  questions: readonly AskUserQuestionQuestion[],
  answers: Record<string, string>
): string {
  const lines = questions.map((question, index) => {
    const { optionNumbers, otherText } = parseAnswerSelection(
      question,
      answers[question.question] ?? ""
    );
    const parts: string[] = [];
    if (optionNumbers.length > 0) {
      parts.push(`${optionNumbers.length > 1 ? "options" : "option"} ${optionNumbers.join(", ")}`);
    }
    if (otherText.length > 0) {
      parts.push(`other: ${JSON.stringify(otherText)}`);
    }
    return `- Question ${index + 1}: ${parts.length > 0 ? parts.join("; ") : "skipped"}`;
  });
  return [
    `The user answered your ask_user_question (tool call ${toolCallId}). ` +
      "Questions and options are numbered as in that call:",
    ...lines,
    "Revisit any work that assumed differently.",
  ].join("\n");
}

/** True for the output of an ask_user_question that returned without waiting for answers. */
export function isAsyncAskUserQuestionOutput(output: unknown): boolean {
  return getToolOutputUiOnly(output)?.ask_user_question?.answerDelivery === "message";
}

/** Reads `muxMetadata.askUserQuestionAnswer`, dropping malformed values (self-healing). */
export function parseAskUserQuestionAnswerMetadata(
  value: unknown
): AskUserQuestionAnswerMetadata | undefined {
  if (value == null || typeof value !== "object") return undefined;
  const record = value as { toolCallId?: unknown; answers?: unknown };
  if (typeof record.toolCallId !== "string" || record.toolCallId.length === 0) return undefined;
  if (record.answers == null || typeof record.answers !== "object") return undefined;
  const answers: Record<string, string> = {};
  for (const [question, answer] of Object.entries(record.answers)) {
    if (typeof answer !== "string") return undefined;
    answers[question] = answer;
  }
  return { toolCallId: record.toolCallId, answers };
}

export function buildAskUserQuestionSummary(answers: Record<string, string>): string {
  const pairs = Object.entries(answers)
    .map(([question, answer]) => `"${question}"="${answer}"`)
    .join(", ");

  return pairs.length > 0
    ? `User has answered your questions: ${pairs}. You can now continue with the user's answers in mind.`
    : "User has answered your questions. You can now continue with the user's answers in mind.";
}
