import type { AskUserQuestionAnswerMetadata } from "@/common/types/message";
import { getToolOutputUiOnly } from "@/common/utils/tools/toolOutputUiOnly";

/**
 * Model-facing result of a non-blocking ask_user_question (Codex-style): the agent keeps working
 * instead of ending its turn, and the answers arrive later as a steering user message.
 */
export const ASK_USER_QUESTION_ASYNC_SUMMARY =
  "Questions shown to the user. Do not wait for the answers and do not end your turn to wait: " +
  "continue working with your best judgment and state the assumptions you make. If the user " +
  "answers, the answers arrive later as a user message; adjust your work to them then.";

/** Queue dedupe key prefix for answer deliveries; the suffix is the tool call id. */
export const ASK_USER_QUESTION_ANSWER_DEDUPE_PREFIX = "ask-user-question-answer:";

/** User-message text that delivers the answers to a non-blocking ask_user_question. */
export function buildAskUserQuestionAnswerMessage(answers: Record<string, string>): string {
  const lines = Object.entries(answers).map(([question, answer]) => {
    const trimmed = answer.trim();
    return `- ${question}\n  Answer: ${trimmed.length > 0 ? trimmed : "(skipped)"}`;
  });
  return [
    "Answers to your earlier ask_user_question:",
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
