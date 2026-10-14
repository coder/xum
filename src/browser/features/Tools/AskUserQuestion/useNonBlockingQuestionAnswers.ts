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
}): {
  /** The questions still take answers. */
  isOpen: boolean;
  /** The answers to show, or null while nothing was answered. */
  answered: { questions: AskUserQuestionQuestion[]; answers: Record<string, string> } | null;
  /** Unanswered, and a context boundary dropped the question from the agent's context. */
  closedUnanswered: boolean;
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

  // A durable row wins over this card's local send (another client may have sent a correction).
  const transcript = props.transcript ?? [];
  const deliveredAnswers = props.enabled
    ? (findLatestAnswerRow(transcript, props.toolCallId) ?? sentAnswers)
    : null;
  // Answers name questions and options by number only, so a question that a compaction, Start
  // Here or reset dropped from the agent's context closes unanswered.
  const leftAgentContext =
    props.enabled && hasAskUserQuestionLeftContext(transcript, props.toolCallId);

  const send = async (
    selections: AskUserQuestionSelection[],
    answers: Record<string, string>
  ): Promise<string | null> => {
    const workspaceId = props.workspaceId;
    try {
      if (!liveApi || !workspaceId) {
        return "API not connected";
      }
      const message = buildAskUserQuestionAnswerMessage(props.toolCallId, selections);
      const pendingSend = pendingSendRef.current;
      const sendId = pendingSend?.message === message ? pendingSend.sendId : createSendId();
      pendingSendRef.current = { message, sendId };
      // Same barrier as the composer: the backend reads send preferences from config.json.
      await flushUserPreferences();
      // The composer's dispatch-time barrier: while the transcript replays, this card may be a
      // stale copy of a question that was edited away or moved behind a boundary.
      if (!isTranscriptMutationAllowed(workspaceId)) {
        return TRANSCRIPT_NOT_CAUGHT_UP_MESSAGE;
      }
      // The render-time check is a snapshot: a boundary may have landed while the preferences
      // flushed, so re-read the latest transcript before sending.
      const latest = workspaceStore.getWorkspaceState(workspaceId).messages;
      if (hasAskUserQuestionLeftContext(latest, props.toolCallId)) {
        return ASK_USER_QUESTION_LEFT_CONTEXT_MESSAGE;
      }
      const result = await liveApi.workspace.sendMessage({
        workspaceId,
        message,
        options: {
          ...getSendOptionsFromStorage(workspaceId),
          sendId,
          muxMetadata: {
            type: "normal",
            askUserQuestionAnswer: { toolCallId: props.toolCallId, answers },
          },
        },
      });
      if (!result.success) {
        const formatted = formatSendMessageError(result.error);
        return [formatted.message, formatted.resolutionHint].filter(Boolean).join(" ");
      }
      pendingSendRef.current = null;
      setSentAnswers(answers);
      return null;
    } catch (error) {
      return getErrorMessage(error);
    }
  };

  return {
    isOpen: props.enabled && deliveredAnswers == null && !leftAgentContext,
    answered:
      deliveredAnswers == null ? null : { questions: props.questions, answers: deliveredAnswers },
    closedUnanswered: leftAgentContext && deliveredAnswers == null,
    send,
  };
}
