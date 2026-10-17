import { useRef, useSyncExternalStore } from "react";

import { useLiveAPI } from "@/browser/contexts/API";
import { flushUserPreferences } from "@/browser/stores/AppConfigStore";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import {
  getAcceptedAnswers,
  setAcceptedAnswers,
  subscribeAcceptedAnswers,
} from "@/browser/utils/messages/askUserQuestionAcceptedAnswers";
import { getSendOptionsFromStorage } from "@/browser/utils/messages/sendOptions";
import { useHostTranscriptMutationCheck } from "@/browser/utils/transcriptBarrier";
import type { DisplayedMessage } from "@/common/types/message";
import type { AskUserQuestionQuestion } from "@/common/types/tools";
import { createSendId } from "@/common/utils/drafts";
import { getErrorMessage } from "@/common/utils/errors";
import { formatSendMessageError } from "@/common/utils/errors/formatSendError";
import {
  ASK_USER_QUESTION_LEFT_CONTEXT_MESSAGE,
  type AskUserQuestionSelection,
  buildAskUserQuestionAnswerMessage,
  ASK_USER_QUESTION_SUPERSEDED_MESSAGE,
  type AskUserQuestionOccurrenceState,
  getAskUserQuestionOccurrenceState,
} from "@/common/utils/tools/askUserQuestionSummary";
import { TRANSCRIPT_NOT_CAUGHT_UP_MESSAGE } from "@/constants/transcriptBarrier";

interface AnsweredQuestions {
  questions: AskUserQuestionQuestion[];
  answers: Record<string, string>;
}

/** Why unanswered questions stopped taking answers. */
export type ClosedUnansweredReason = "left-context" | "superseded";

interface NonBlockingQuestionState {
  /** The questions still take answers. */
  isOpen: boolean;
  /** The answers to show, or null while nothing was answered. */
  answered: AnsweredQuestions | null;
  /** Set when the questions closed without answers. */
  closedUnanswered: ClosedUnansweredReason | null;
}

const NOT_NON_BLOCKING: NonBlockingQuestionState = {
  isOpen: false,
  answered: null,
  closedUnanswered: null,
};

/** The refusal (and closed-card note) for each way unanswered questions close. */
export const CLOSED_UNANSWERED_MESSAGES: Record<ClosedUnansweredReason, string> = {
  "left-context": ASK_USER_QUESTION_LEFT_CONTEXT_MESSAGE,
  superseded: ASK_USER_QUESTION_SUPERSEDED_MESSAGE,
};

function getClosedUnansweredReason(
  state: AskUserQuestionOccurrenceState
): ClosedUnansweredReason | null {
  if (state.superseded) return "superseded";
  return state.leftContext ? "left-context" : null;
}

/**
 * Where a non-blocking question stands. A durable answer row wins over this card's own accepted
 * send (another client may have sent a correction). Answers name questions and options by
 * number and the call by its tool call id, so unanswered questions close once a compaction,
 * Start Here or reset drops them from the agent's context, or once a later question reuses the
 * tool call id (see getAskUserQuestionOccurrences).
 */
export function getNonBlockingQuestionState(args: {
  enabled: boolean;
  toolCallId: string;
  /** The transcript row's display id: tells apart rows that reuse a tool call id. */
  rowId: string | undefined;
  questions: AskUserQuestionQuestion[];
  transcript: readonly DisplayedMessage[] | undefined;
  sentAnswers: Record<string, string> | null;
}): NonBlockingQuestionState {
  if (!args.enabled) {
    return NOT_NON_BLOCKING;
  }
  const state = getAskUserQuestionOccurrenceState(args.transcript ?? [], {
    toolCallId: args.toolCallId,
    rowId: args.rowId,
  });
  const answers = state.answers ?? args.sentAnswers;
  if (answers != null) {
    return {
      isOpen: false,
      answered: { questions: args.questions, answers },
      closedUnanswered: null,
    };
  }
  const closedUnanswered = getClosedUnansweredReason(state);
  return { isOpen: closedUnanswered === null, answered: null, closedUnanswered };
}

/**
 * The latest transcript, read fail-soft like the card's render path: a host that does not feed
 * WorkspaceStore (the VS Code webview) has no transcript here, so the context check has nothing
 * to see there, as at render time, instead of failing every answer.
 */
function readStoreTranscript(
  store: ReturnType<typeof useWorkspaceStoreRaw>,
  workspaceId: string
): readonly DisplayedMessage[] {
  try {
    return store.getWorkspaceState(workspaceId).messages;
  } catch {
    return [];
  }
}

/**
 * Dispatches one answer message, behind the composer's barriers. Resolves with an error message,
 * or null once the backend accepted the send.
 */
async function dispatchAnswerMessage(args: {
  api: NonNullable<ReturnType<typeof useLiveAPI>>;
  workspaceId: string;
  toolCallId: string;
  rowId: string | undefined;
  message: string;
  sendId: string;
  answers: Record<string, string>;
  isTranscriptMutationAllowed: (workspaceId: string) => boolean;
  readTranscript: (workspaceId: string) => readonly DisplayedMessage[];
}): Promise<string | null> {
  try {
    // Same barrier as the composer: the backend reads send preferences from config.json.
    await flushUserPreferences();
    // The composer's dispatch-time barrier: while the transcript replays, this card may be a
    // stale copy of a question that was edited away or moved behind a boundary.
    if (!args.isTranscriptMutationAllowed(args.workspaceId)) {
      return TRANSCRIPT_NOT_CAUGHT_UP_MESSAGE;
    }
    // The render-time state is a snapshot: a boundary or a question reusing the tool call id may
    // have landed while the preferences flushed, so re-read the latest transcript before sending.
    const closedUnanswered = getClosedUnansweredReason(
      getAskUserQuestionOccurrenceState(args.readTranscript(args.workspaceId), {
        toolCallId: args.toolCallId,
        rowId: args.rowId,
      })
    );
    if (closedUnanswered !== null) {
      return CLOSED_UNANSWERED_MESSAGES[closedUnanswered];
    }
    const result = await args.api.workspace.sendMessage({
      workspaceId: args.workspaceId,
      message: args.message,
      options: {
        ...getSendOptionsFromStorage(args.workspaceId),
        sendId: args.sendId,
        muxMetadata: {
          type: "normal",
          askUserQuestionAnswer: { toolCallId: args.toolCallId, answers: args.answers },
        },
      },
    });
    if (!result.success) {
      const formatted = formatSendMessageError(result.error);
      return [formatted.message, formatted.resolutionHint].filter(Boolean).join(" ");
    }
    return null;
  } catch (error) {
    return getErrorMessage(error);
  }
}

/**
 * Codex-style (non-blocking) ask_user_question answers: the tool already returned, so the card
 * sends its answers as ordinary user input, exactly like a composer message. The default queue
 * mode steers a running turn after its current step; an idle workspace starts a new turn.
 */
export function useNonBlockingQuestionAnswers(props: {
  enabled: boolean;
  workspaceId: string | undefined;
  toolCallId: string;
  /** The transcript row's display id: tells apart rows that reuse a tool call id. */
  rowId: string | undefined;
  questions: AskUserQuestionQuestion[];
  transcript: readonly DisplayedMessage[] | undefined;
}): NonBlockingQuestionState & {
  /** Sends the answers; resolves with an error message, or null once the send was accepted. */
  send: (
    selections: AskUserQuestionSelection[],
    answers: Record<string, string>
  ) => Promise<string | null>;
} {
  const liveApi = useLiveAPI();
  const workspaceStore = useWorkspaceStoreRaw();
  const isTranscriptMutationAllowed = useHostTranscriptMutationCheck();
  const sentAnswers = useSyncExternalStore(subscribeAcceptedAnswers, () =>
    getAcceptedAnswers(props)
  );
  // The idempotency id of the last unconfirmed send. A retry of the same message reuses it, so
  // a lost success response cannot produce a second answer row (the backend never appends a
  // second row for an id a row already carries).
  const pendingSendRef = useRef<{ message: string; sendId: string } | null>(null);

  const send = async (
    selections: AskUserQuestionSelection[],
    answers: Record<string, string>
  ): Promise<string | null> => {
    if (!liveApi || !props.workspaceId) {
      return "API not connected";
    }
    const message = buildAskUserQuestionAnswerMessage(props.toolCallId, selections);
    const pendingSend = pendingSendRef.current;
    const sendId = pendingSend?.message === message ? pendingSend.sendId : createSendId();
    pendingSendRef.current = { message, sendId };
    const error = await dispatchAnswerMessage({
      api: liveApi,
      workspaceId: props.workspaceId,
      toolCallId: props.toolCallId,
      rowId: props.rowId,
      message,
      sendId,
      answers,
      isTranscriptMutationAllowed,
      readTranscript: (workspaceId) => readStoreTranscript(workspaceStore, workspaceId),
    });
    if (error == null) {
      pendingSendRef.current = null;
      setAcceptedAnswers(props, answers);
    }
    return error;
  };

  return {
    ...getNonBlockingQuestionState({
      enabled: props.enabled,
      toolCallId: props.toolCallId,
      rowId: props.rowId,
      questions: props.questions,
      transcript: props.transcript,
      sentAnswers,
    }),
    send,
  };
}
