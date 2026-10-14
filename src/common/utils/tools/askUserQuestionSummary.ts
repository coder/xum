import { z } from "zod";

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

/**
 * Refusal for answering a question that is not blocking on an answer: an Exec question seen
 * before its immediate result arrived, or one already completed without answers.
 */
export const ASK_USER_QUESTION_NOT_WAITING_MESSAGE =
  "This question is not waiting for an answer here. Try again in a moment.";

/** Refusal for a non-blocking answer whose question was dropped from the agent's context. */
export const ASK_USER_QUESTION_LEFT_CONTEXT_MESSAGE =
  "These questions are no longer in the agent's context.";

/**
 * True when a context boundary (compaction, Start Here, reset) follows the question's tool row.
 * Answers name questions and options by number only, so they mean nothing to the model then.
 */
export function hasAskUserQuestionLeftContext(
  transcript: ReadonlyArray<{ type: string; toolCallId?: string }>,
  toolCallId: string
): boolean {
  const ownRowIndex = transcript.findIndex(
    (message) => message.type === "tool" && message.toolCallId === toolCallId
  );
  return (
    ownRowIndex !== -1 &&
    transcript.slice(ownRowIndex + 1).some((message) => message.type === "compaction-boundary")
  );
}

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

const AskUserQuestionAnswerHolderSchema = z.object({
  askUserQuestionAnswer: z.object({
    toolCallId: z.string().min(1),
    answers: z.record(z.string(), z.string()),
  }),
});

/** Reads `muxMetadata.askUserQuestionAnswer`, dropping missing or malformed values (self-healing). */
export function parseAskUserQuestionAnswerMetadata(
  muxMetadata: unknown
): AskUserQuestionAnswerMetadata | undefined {
  const parsed = AskUserQuestionAnswerHolderSchema.safeParse(muxMetadata);
  return parsed.success ? parsed.data.askUserQuestionAnswer : undefined;
}

export function buildAskUserQuestionSummary(answers: Record<string, string>): string {
  const pairs = Object.entries(answers)
    .map(([question, answer]) => `"${question}"="${answer}"`)
    .join(", ");

  return pairs.length > 0
    ? `User has answered your questions: ${pairs}. You can now continue with the user's answers in mind.`
    : "User has answered your questions. You can now continue with the user's answers in mind.";
}
