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
 * Refusal for a non-blocking answer whose question a later ask_user_question replaced: the later
 * call reused its tool call id, and the answer message names questions by that id.
 */
export const ASK_USER_QUESTION_SUPERSEDED_MESSAGE =
  "A later question replaced these questions, so the agent would read answers as meant for it.";

/** The transcript fields the occurrence scan reads (DisplayedMessage, minimally). */
export interface AskUserQuestionTranscriptRow {
  type: string;
  id?: string;
  toolName?: string;
  toolCallId?: string;
  askUserQuestionAnswer?: AskUserQuestionAnswerMetadata;
}

/** Where one ask_user_question row stands, from the transcript alone. */
export interface AskUserQuestionOccurrenceState {
  /** The latest answer row that belongs to this row, or undefined. */
  answers: Record<string, string> | undefined;
  /** A later ask_user_question row reuses this row's tool call id. */
  superseded: boolean;
  /** A context boundary (compaction, Start Here, reset) follows this row. */
  leftContext: boolean;
}

export interface AskUserQuestionOccurrence<Row extends AskUserQuestionTranscriptRow> {
  row: Row;
  index: number;
  state: AskUserQuestionOccurrenceState;
}

function isAskUserQuestionRow(row: AskUserQuestionTranscriptRow): boolean {
  return row.type === "tool" && row.toolName === "ask_user_question";
}

/**
 * Every ask_user_question row with its state, in transcript order, in one pass.
 *
 * Providers may reuse a tool call id within a workspace (local OpenAI-compatible models often
 * emit `call_0` every turn), so the id alone does not name a question. Rows are told apart by
 * position instead, which also covers answer rows persisted before this rule:
 * - an answer row belongs to the latest ask_user_question row with its id that precedes it;
 * - a later row with the same id supersedes an earlier one. The answer message names questions
 *   by id, so the agent reads any answer to that id as meant for its latest call; only the
 *   latest row may take answers. A superseded row keeps answers it got before.
 */
export function getAskUserQuestionOccurrences<Row extends AskUserQuestionTranscriptRow>(
  transcript: readonly Row[]
): Array<AskUserQuestionOccurrence<Row>> {
  const occurrences: Array<AskUserQuestionOccurrence<Row>> = [];
  const latestByToolCallId = new Map<string, AskUserQuestionOccurrence<Row>>();
  let lastBoundaryIndex = -1;
  transcript.forEach((row, index) => {
    if (row.type === "compaction-boundary") {
      lastBoundaryIndex = index;
    } else if (row.askUserQuestionAnswer != null) {
      const owner = latestByToolCallId.get(row.askUserQuestionAnswer.toolCallId);
      if (owner) owner.state.answers = row.askUserQuestionAnswer.answers;
    } else if (isAskUserQuestionRow(row) && row.toolCallId != null) {
      const toolCallId = row.toolCallId;
      const previous = latestByToolCallId.get(toolCallId);
      if (previous) previous.state.superseded = true;
      const occurrence = {
        row,
        index,
        state: { answers: undefined, superseded: false, leftContext: false },
      };
      latestByToolCallId.set(toolCallId, occurrence);
      occurrences.push(occurrence);
    }
  });
  for (const occurrence of occurrences) {
    occurrence.state.leftContext = occurrence.index < lastBoundaryIndex;
  }
  return occurrences;
}

/**
 * Whether an ask_user_question row still takes answers, from the transcript alone: a blocking
 * question while its tool call executes, and a non-blocking one until an answer row for it lands,
 * a later question reuses its tool call id, or a boundary drops it from the agent's context.
 */
export function isAskUserQuestionOccurrenceOpen(
  row: { status?: string; result?: unknown },
  state: AskUserQuestionOccurrenceState
): boolean {
  if (row.status === "executing") return true;
  return (
    isAsyncAskUserQuestionOutput(row.result) &&
    state.answers === undefined &&
    !state.superseded &&
    !state.leftContext
  );
}

/**
 * The state of one ask_user_question row: the row with `rowId` (a transcript row's display id),
 * or without one the latest row with `toolCallId`. A row missing from the transcript (a host that
 * feeds none, or history not loaded yet) is judged by its id alone, as before rows were told apart.
 */
export function getAskUserQuestionOccurrenceState(
  transcript: readonly AskUserQuestionTranscriptRow[],
  question: { toolCallId: string; rowId?: string }
): AskUserQuestionOccurrenceState {
  const own = getAskUserQuestionOccurrences(transcript)
    .filter(
      (occurrence) =>
        occurrence.row.toolCallId === question.toolCallId &&
        (question.rowId == null || occurrence.row.id === question.rowId)
    )
    .at(-1);
  if (own) return own.state;
  const answerRow = transcript.findLast(
    (row) => row.askUserQuestionAnswer?.toolCallId === question.toolCallId
  );
  return {
    answers: answerRow?.askUserQuestionAnswer?.answers,
    superseded: false,
    leftContext: false,
  };
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
