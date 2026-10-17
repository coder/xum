import { useSyncExternalStore } from "react";

// Kept free of store and API imports: StreamingMessageAggregator reads it too (transcript
// truncation must not keep a question this app already answered), and WorkspaceStore imports the
// aggregator.

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
