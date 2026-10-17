import { createContext, useContext } from "react";

import type { DisplayedMessage } from "@/common/types/message";
import {
  getAskUserQuestionOccurrences,
  isAskUserQuestionOccurrenceOpen,
} from "@/common/utils/tools/askUserQuestionSummary";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { getAcceptedAnswers } from "./useNonBlockingQuestionAnswers";

/**
 * Where an ask_user_question card renders.
 *
 * Open questions are docked above the chat input (sticky to the bottom of the chat) so they stay
 * in view while the agent keeps streaming below a non-blocking question, while a work bundle
 * collapses the row, or while the user scrolls up to read context. The transcript keeps a compact
 * stub in the question's place so the history still shows where it was asked.
 *
 * - `inline` (default): hosts without a dock (VS Code webview, sub-agent dialogs, stories) render
 *   the whole card in place, as before.
 * - `transcript`: ChatPane's transcript; the docked questions render as stubs.
 * - `dock`: the dock above the chat input; a card renders nothing once its questions close, and
 *   the dock unmounts it once it releases itself.
 */
export type AskUserQuestionPlacement =
  | { kind: "inline" }
  | {
      kind: "transcript";
      workspaceId: string;
      /** Transcript row display ids, which tell apart rows that reuse a tool call id. */
      dockedRowIds: ReadonlySet<string>;
    }
  | {
      kind: "dock";
      /** A closed card has nothing left to do (its auto-retry rollback settled): unmount it. */
      release: (rowId: string) => void;
    };

const INLINE_PLACEMENT: AskUserQuestionPlacement = { kind: "inline" };

const AskUserQuestionPlacementContext = createContext<AskUserQuestionPlacement>(INLINE_PLACEMENT);

export const AskUserQuestionPlacementProvider = AskUserQuestionPlacementContext.Provider;

export function useAskUserQuestionPlacement(): AskUserQuestionPlacement {
  return useContext(AskUserQuestionPlacementContext);
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
  workspaceId: string,
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

/**
 * ChatPane's transcript placement. Transcript-only workspaces have no composer, so no dock: the
 * transcript keeps the whole card there. Otherwise the dock shows open questions from the first
 * render (it skips the decoration reveal gate), so a form never moves while it is being answered.
 * Every given transcript snapshot counts (ChatPane passes the immediate and the deferred rows), so
 * a transcript row lagging the dock never flashes a second form.
 */
export function getTranscriptAskUserQuestionPlacement(args: {
  workspaceId: string;
  transcriptOnly: boolean;
  transcripts: ReadonlyArray<readonly DisplayedMessage[]>;
}): AskUserQuestionPlacement {
  const dockedRowIds = new Set<string>();
  if (!args.transcriptOnly) {
    for (const transcript of args.transcripts) {
      for (const question of findOpenAskUserQuestions(args.workspaceId, transcript)) {
        dockedRowIds.add(question.id);
      }
    }
  }
  return { kind: "transcript", workspaceId: args.workspaceId, dockedRowIds };
}

/**
 * The rows the dock holds. Its cards stay mounted after their questions close, until they release
 * themselves, so a blocking answer's auto-retry rollback can watch the resumed stream.
 */
export type DockedQuestionIds = readonly string[];

export const NO_DOCKED_QUESTIONS: DockedQuestionIds = [];

/** Docks newly open questions; returns `docked` itself when nothing changed. */
export function reconcileDockedQuestionIds(
  docked: DockedQuestionIds,
  openRowIds: readonly string[]
): DockedQuestionIds {
  const newlyOpen = openRowIds.filter((id) => !docked.includes(id));
  return newlyOpen.length === 0 ? docked : [...docked, ...newlyOpen];
}

export function releaseDockedQuestionId(
  docked: DockedQuestionIds,
  rowId: string
): DockedQuestionIds {
  return docked.includes(rowId) ? docked.filter((id) => id !== rowId) : docked;
}
