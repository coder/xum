import { useSyncExternalStore } from "react";

import type { DisplayedMessage } from "@/common/types/message";
import {
  getAskUserQuestionOccurrences,
  isAskUserQuestionOccurrenceOpen,
} from "@/common/utils/tools/askUserQuestionSummary";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

// Which ask_user_question rows still take answers. One selector serves the dock above the chat
// input, the transcript stubs and transcript truncation (StreamingMessageAggregator keeps these
// rows past its display cap), so they can never disagree. Kept free of store and API imports,
// since WorkspaceStore imports the aggregator.

// Answers whose message the backend accepted, by question row. Like Codex, the question is then
// done; the message is ordinary input, so a queued one the user withdraws (Stop) comes back to the
// composer like any queued message. This also covers a message batched into an earlier queued
// one, whose metadata the queue does not keep, so no answer row may ever land. Held for the app
// session rather than per card: the dock above the chat input, the transcript row and a remounted
// card must all agree the question is answered, or the form would come back.
const acceptedAnswers = new Map<string, Record<string, string>>();
const acceptedAnswersListeners = new Set<() => void>();
let acceptedAnswersVersion = 0;

/** One question row: rows are told apart by display id, since providers may reuse tool call ids. */
export interface QuestionRowKey {
  workspaceId: string | undefined;
  toolCallId: string;
  rowId: string | undefined;
}

function getAcceptedAnswersKey(question: QuestionRowKey): string {
  return JSON.stringify([
    question.workspaceId ?? null,
    question.toolCallId,
    question.rowId ?? null,
  ]);
}

export function subscribeAcceptedAnswers(listener: () => void): () => void {
  acceptedAnswersListeners.add(listener);
  return () => acceptedAnswersListeners.delete(listener);
}

/** The answers this app accepted for a non-blocking question row, or null. */
export function getAcceptedAnswers(question: QuestionRowKey): Record<string, string> | null {
  return acceptedAnswers.get(getAcceptedAnswersKey(question)) ?? null;
}

export function setAcceptedAnswers(
  question: QuestionRowKey,
  answers: Record<string, string>
): void {
  acceptedAnswers.set(getAcceptedAnswersKey(question), answers);
  acceptedAnswersVersion += 1;
  for (const listener of acceptedAnswersListeners) {
    listener();
  }
}

/** Re-renders the caller whenever a non-blocking answer is accepted (see getAcceptedAnswers). */
export function useAcceptedAnswersVersion(): number {
  return useSyncExternalStore(subscribeAcceptedAnswers, () => acceptedAnswersVersion);
}

export type AskUserQuestionToolMessage = Extract<DisplayedMessage, { type: "tool" }>;

/**
 * Rows with malformed args render as the generic tool card, which neither takes answers nor
 * releases itself from the dock, so they stay in the transcript (checked last: it parses args).
 */
function hasValidAskUserQuestionArgs(message: AskUserQuestionToolMessage): boolean {
  return TOOL_DEFINITIONS.ask_user_question.schema.safeParse(message.args).success;
}

function isToolRow(message: DisplayedMessage): message is AskUserQuestionToolMessage {
  return message.type === "tool";
}

/**
 * The ask_user_question rows that still take answers, in transcript order: a blocking question
 * while its tool call executes, and a non-blocking one until this app accepted its answers, an
 * answer row for it lands, a compaction boundary drops it from the agent's context, or a later
 * question reuses its tool call id. These are the card's own checks on the same row (see
 * getNonBlockingQuestionState): if the two disagreed, a docked card would release a row that
 * this keeps re-adding. One pass, since ChatPane runs it on every streamed delta.
 */
export function findOpenAskUserQuestions(
  workspaceId: string | undefined,
  messages: readonly DisplayedMessage[]
): AskUserQuestionToolMessage[] {
  return getAskUserQuestionOccurrences(messages)
    .filter(
      ({ row, state }) =>
        isToolRow(row) &&
        isAskUserQuestionOccurrenceOpen(row, state) &&
        getAcceptedAnswers({ workspaceId, toolCallId: row.toolCallId, rowId: row.id }) === null
    )
    .map(({ row }) => row)
    .filter(isToolRow)
    .filter(hasValidAskUserQuestionArgs);
}
