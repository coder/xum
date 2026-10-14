import { useRef, useState } from "react";

import { useLiveAPI } from "@/browser/contexts/API";
import { flushUserPreferences } from "@/browser/stores/AppConfigStore";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
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
  hasAskUserQuestionLeftContext,
} from "@/common/utils/tools/askUserQuestionSummary";
import { TRANSCRIPT_NOT_CAUGHT_UP_MESSAGE } from "@/constants/transcriptBarrier";

/** The latest answer row for this tool call: a later correction supersedes earlier answers. */
function findLatestAnswerRow(
  transcript: readonly DisplayedMessage[],
  toolCallId: string
): Record<string, string> | undefined {
  for (let index = transcript.length - 1; index >= 0; index--) {
    const message = transcript[index];
    if (message.type === "user" && message.askUserQuestionAnswer?.toolCallId === toolCallId) {
      return message.askUserQuestionAnswer.answers;
    }
  }
  return undefined;
}

interface AnsweredQuestions {
  questions: AskUserQuestionQuestion[];
  answers: Record<string, string>;
}

interface NonBlockingQuestionState {
  /** The questions still take answers. */
  isOpen: boolean;
  /** The answers to show, or null while nothing was answered. */
  answered: AnsweredQuestions | null;
  /** Unanswered, and a context boundary dropped the question from the agent's context. */
  closedUnanswered: boolean;
}

const NOT_NON_BLOCKING: NonBlockingQuestionState = {
  isOpen: false,
  answered: null,
  closedUnanswered: false,
};

/**
 * Where a non-blocking question stands. A durable answer row wins over this card's own accepted
 * send (another client may have sent a correction); answers name questions and options by
 * number only, so a question that a compaction, Start Here or reset dropped from the agent's
 * context closes unanswered.
 */
export function getNonBlockingQuestionState(args: {
  enabled: boolean;
  toolCallId: string;
  questions: AskUserQuestionQuestion[];
  transcript: readonly DisplayedMessage[] | undefined;
  sentAnswers: Record<string, string> | null;
}): NonBlockingQuestionState {
  if (!args.enabled) {
    return NOT_NON_BLOCKING;
  }
  const transcript = args.transcript ?? [];
  const answers = findLatestAnswerRow(transcript, args.toolCallId) ?? args.sentAnswers;
  if (answers != null) {
    return {
      isOpen: false,
      answered: { questions: args.questions, answers },
      closedUnanswered: false,
    };
  }
  const leftAgentContext = hasAskUserQuestionLeftContext(transcript, args.toolCallId);
  return { isOpen: !leftAgentContext, answered: null, closedUnanswered: leftAgentContext };
}

/**
 * Dispatches one answer message, behind the composer's barriers. Resolves with an error message,
 * or null once the backend accepted the send.
 */
async function dispatchAnswerMessage(args: {
  api: NonNullable<ReturnType<typeof useLiveAPI>>;
  workspaceId: string;
  toolCallId: string;
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
    // The render-time state is a snapshot: a boundary may have landed while the preferences
    // flushed, so re-read the latest transcript before sending.
    if (hasAskUserQuestionLeftContext(args.readTranscript(args.workspaceId), args.toolCallId)) {
      return ASK_USER_QUESTION_LEFT_CONTEXT_MESSAGE;
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
  // Answers whose message the backend accepted. Like Codex, the question is then done from this
  // card's view; the message is ordinary input, so a queued one the user withdraws (Stop) comes
  // back to the composer like any queued message. This also covers a message batched into an
  // earlier queued one, whose metadata the queue does not keep.
  const [sentAnswers, setSentAnswers] = useState<Record<string, string> | null>(null);
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
      message,
      sendId,
      answers,
      isTranscriptMutationAllowed,
      readTranscript: (workspaceId) => workspaceStore.getWorkspaceState(workspaceId).messages,
    });
    if (error == null) {
      pendingSendRef.current = null;
      setSentAnswers(answers);
    }
    return error;
  };

  return {
    ...getNonBlockingQuestionState({
      enabled: props.enabled,
      toolCallId: props.toolCallId,
      questions: props.questions,
      transcript: props.transcript,
      sentAnswers,
    }),
    send,
  };
}
