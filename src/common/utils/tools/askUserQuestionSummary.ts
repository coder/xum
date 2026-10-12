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

/** One question's answer as picked on the card: 1-based option numbers plus the user's own text. */
export interface AskUserQuestionSelection {
  optionNumbers: number[];
  otherText: string;
}

/**
 * User-message text that delivers the answers to a non-blocking ask_user_question. The card
 * sends it like a typed chat message (Codex answers its async questions with ordinary user
 * input): it steers a running turn after the current step, or starts a new turn when idle.
 *
 * SECURITY: question text and option labels are model-authored, so they must not be promoted
 * into a user-role message (repository or tool content could plant instructions in them).
 * The message refers to questions and options by number, and includes only the text the user
 * typed for "Other"; the model reads the wording from its own tool call.
 */
export function buildAskUserQuestionAnswerMessage(
  toolCallId: string,
  selections: readonly AskUserQuestionSelection[]
): string {
  const lines = selections.map((selection, index) => {
    const parts: string[] = [];
    const { optionNumbers } = selection;
    if (optionNumbers.length > 0) {
      parts.push(`${optionNumbers.length > 1 ? "options" : "option"} ${optionNumbers.join(", ")}`);
    }
    const otherText = selection.otherText.trim();
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
