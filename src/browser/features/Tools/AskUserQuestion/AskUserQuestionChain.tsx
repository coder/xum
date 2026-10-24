import { useEffect, useState } from "react";

import { ToolNameProvider } from "@/browser/features/Messages/ToolNameContext";
import { ToolContainer, ToolDetails } from "@/browser/features/Tools/Shared/ToolPrimitives";
import { useToolExpansion } from "@/browser/features/Tools/Shared/toolUtils";
import type { AskUserQuestionToolMessage } from "@/browser/utils/messages/openAskUserQuestions";
import type { AskUserQuestionQuestion } from "@/common/types/tools";
import { getErrorMessage } from "@/common/utils/errors";
import { AskUserQuestionToolArgsSchema } from "@/common/utils/tools/askUserQuestionSchemas";

import {
  ASK_USER_QUESTION_HINTS,
  AskUserQuestionForm,
  AskUserQuestionHeader,
  type AskUserQuestionFormGroup,
} from "./AskUserQuestionForm";
import {
  applyDraftEdit,
  buildAnswerSelections,
  buildAnswersRecord,
  createInitialDrafts,
  deleteCachedDraftState,
  type DraftAnswer,
  type DraftAnswers,
  getCachedDraftState,
  getDraftStateKey,
  setCachedDraftState,
} from "./askUserQuestionDrafts";
import { useNonBlockingAnswerSender } from "./useNonBlockingQuestionAnswers";

export interface AskUserQuestionChainProps {
  workspaceId: string;
  /** The dock's non-blocking question rows, in dock order (closed ones until released). */
  rows: readonly AskUserQuestionToolMessage[];
  /** The rows that still take answers. */
  openRowIds: ReadonlySet<string>;
  /** Unmounts a closed row from the dock (see AskUserQuestionPlacement's `release`). */
  release: (rowId: string) => void;
}

/** One open call on the chained form, keyed by its transcript row id. */
interface ChainGroup extends AskUserQuestionFormGroup {
  row: AskUserQuestionToolMessage;
  questions: AskUserQuestionQuestion[];
  draftKey: string;
}

interface ChainRow {
  row: AskUserQuestionToolMessage;
  questions: AskUserQuestionQuestion[];
  prefilled: Record<string, string> | null | undefined;
  draftKey: string;
}

/** The open rows with their parsed args, in dock order (the dock only docks valid args). */
function getOpenChainRows(props: AskUserQuestionChainProps): ChainRow[] {
  return props.rows.flatMap((row) => {
    if (!props.openRowIds.has(row.id)) {
      return [];
    }
    const args = AskUserQuestionToolArgsSchema.safeParse(row.args);
    if (!args.success) {
      return [];
    }
    const draftKey = getDraftStateKey({
      workspaceId: props.workspaceId,
      rowId: row.id,
      toolCallId: row.toolCallId,
    });
    return [{ row, questions: args.data.questions, prefilled: args.data.answers, draftKey }];
  });
}

function toChainGroup(chainRow: ChainRow, edited: Record<string, DraftAnswers>): ChainGroup {
  return {
    key: chainRow.row.id,
    row: chainRow.row,
    questions: chainRow.questions,
    draftKey: chainRow.draftKey,
    drafts:
      edited[chainRow.row.id] ??
      getCachedDraftState(chainRow.draftKey)?.draftAnswers ??
      createInitialDrafts(chainRow.questions, chainRow.prefilled),
  };
}

/** Writes the open rows' drafts to the cache and drops closed rows' drafts, like the card. */
function syncDraftCache(props: AskUserQuestionChainProps, groups: readonly ChainGroup[]): void {
  for (const group of groups) {
    setCachedDraftState(group.draftKey, {
      draftAnswers: group.drafts,
      activeIndex: getCachedDraftState(group.draftKey)?.activeIndex ?? 0,
    });
  }
  const openKeys = new Set(groups.map((group) => group.key));
  for (const row of props.rows.filter((docked) => !openKeys.has(docked.id))) {
    deleteCachedDraftState(
      getDraftStateKey({
        workspaceId: props.workspaceId,
        rowId: row.id,
        toolCallId: row.toolCallId,
      })
    );
  }
}

/**
 * Each open row's drafts: edited here, else the draft cache (a workspace switch and back), else
 * the call's prefilled answers, exactly like the single card. Written back to the cache while
 * open, so a remount (and the single card) finds them.
 */
function useChainGroups(props: AskUserQuestionChainProps) {
  const [edited, setEdited] = useState<Record<string, DraftAnswers>>({});
  const groups = getOpenChainRows(props).map((chainRow) => toChainGroup(chainRow, edited));

  // No deps: the module cache must follow every render's drafts and open rows.
  useEffect(() => syncDraftCache(props, groups));

  const changeDraft = (
    rowId: string,
    question: string,
    update: (draft: DraftAnswer) => DraftAnswer
  ) => {
    const seed = groups.find((group) => group.key === rowId)?.drafts ?? {};
    setEdited((prev) => ({
      ...prev,
      [rowId]: applyDraftEdit(prev[rowId] ?? seed, question, update),
    }));
  };

  return { groups, changeDraft };
}

interface QuestionEntryKey {
  rowId: string;
  questionIndex: number;
}

/** The active tab: a question of one row, or the Summary. Null while no question set is open. */
type ActiveEntryKey = QuestionEntryKey | "summary" | null;

// Per workspace, so the active tab survives a workspace switch (the dock remounts per workspace).
const activeEntryByWorkspace = new Map<string, ActiveEntryKey>();

function isQuestionOf(key: QuestionEntryKey, group: ChainGroup): boolean {
  return key.rowId === group.key && key.questionIndex < group.questions.length;
}

/** Whether the key names a tab of the open groups (null does exactly while none is open). */
function isValidEntryKey(key: ActiveEntryKey, groups: readonly ChainGroup[]): boolean {
  if (key === null) {
    return groups.length === 0;
  }
  if (key === "summary") {
    return groups.length > 0;
  }
  return groups.some((group) => isQuestionOf(key, group));
}

function resolveActiveIndex(key: ActiveEntryKey, groups: readonly ChainGroup[]): number {
  const total = groups.reduce((count, group) => count + group.questions.length, 0);
  if (key === "summary") {
    return total;
  }
  let offset = 0;
  for (const group of groups) {
    if (key !== null && isQuestionOf(key, group)) {
      return offset + key.questionIndex;
    }
    offset += group.questions.length;
  }
  // Only for a key that this render replaces (see useChainActiveIndex): the first question.
  return 0;
}

function getActiveEntryKey(index: number, groups: readonly ChainGroup[]): ActiveEntryKey {
  let offset = 0;
  for (const group of groups) {
    if (index < offset + group.questions.length) {
      return { rowId: group.key, questionIndex: index - offset };
    }
    offset += group.questions.length;
  }
  return "summary";
}

/**
 * Where the chain goes when its key names no open tab (it starts, or the key's row closed): the
 * tab a single card left its row on, else the first question. A non-blocking call has no result
 * while it executes, so it renders as its own card until it returns, then moves into the chain;
 * that card cached its tab with its drafts.
 */
function getStartKey(groups: readonly ChainGroup[]): ActiveEntryKey {
  for (const group of groups) {
    const cardIndex = getCachedDraftState(group.draftKey)?.activeIndex ?? 0;
    if (cardIndex > 0) {
      // The card's Summary comes right after its last question.
      return cardIndex < group.questions.length
        ? { rowId: group.key, questionIndex: cardIndex }
        : "summary";
    }
  }
  return groups.length > 0 ? { rowId: groups[0].key, questionIndex: 0 } : null;
}

/**
 * The active tab, stored by row and question rather than by position: a row appended while the
 * user answers adds tabs after the current one without moving it. The key always names an open
 * tab, even when the user never moved, so a remount restores it rather than the stale tab of a
 * card that joined later; when it names none (here or after a workspace switch), getStartKey
 * picks the tab.
 */
function useChainActiveIndex(workspaceId: string, groups: readonly ChainGroup[]) {
  const [activeKey, setActiveKey] = useState<ActiveEntryKey>(
    () => activeEntryByWorkspace.get(workspaceId) ?? null
  );
  if (!isValidEntryKey(activeKey, groups)) {
    // Adjust state during render (no effect). It settles in one pass: getStartKey's key is valid,
    // since every open row has at least one question.
    setActiveKey(getStartKey(groups));
  }

  useEffect(() => {
    if (activeKey === null) {
      activeEntryByWorkspace.delete(workspaceId);
    } else {
      activeEntryByWorkspace.set(workspaceId, activeKey);
    }
  }, [workspaceId, activeKey]);

  return {
    activeIndex: resolveActiveIndex(activeKey, groups),
    activate: (index: number) => setActiveKey(getActiveEntryKey(index, groups)),
  };
}

/** Submit: one message for every open call, through the non-blocking send path. */
function useChainSubmit(workspaceId: string, groups: readonly ChainGroup[]) {
  const sendAnswers = useNonBlockingAnswerSender(workspaceId);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const submit = () => {
    setIsSubmitting(true);
    setSubmitError(null);
    sendAnswers(
      groups.map((group) => ({
        toolCallId: group.row.toolCallId,
        rowId: group.row.id,
        selections: buildAnswerSelections(group.questions, group.drafts),
        answers: buildAnswersRecord(group.questions, group.drafts),
      }))
    )
      .finally(() => {
        setIsSubmitting(false);
      })
      .then(setSubmitError, (error: unknown) => {
        setSubmitError(getErrorMessage(error));
      });
  };

  return { submit, isSubmitting, submitError };
}

/**
 * Lets the dock drop closed rows, but only once no submit is in flight: the rows a submit sent
 * stay docked until it settles (the same contract as the single card's useReleaseSettledDockCard).
 */
function useReleaseClosedRows(props: AskUserQuestionChainProps, isSubmitting: boolean): void {
  const { rows, openRowIds, release } = props;
  useEffect(() => {
    if (isSubmitting) {
      return;
    }
    for (const row of rows) {
      if (!openRowIds.has(row.id)) {
        release(row.id);
      }
    }
  }, [rows, openRowIds, release, isSubmitting]);
}

/**
 * Open questions must never hide behind a collapsed "tools" preference, and the header still
 * collapses the form. A call that arrives after the user collapsed it re-opens the form, as a new
 * card did before the chain: otherwise its questions would stay hidden with no hint.
 */
function useChainExpansion(openRowIds: readonly string[]) {
  const { expanded, setExpanded } = useToolExpansion(false, { forceExpanded: true });
  // The open rows the user collapsed the form over; null unless they collapsed it.
  const [collapsedOver, setCollapsedOver] = useState<readonly string[] | null>(null);
  const hasNewRow = collapsedOver !== null && hasRowOutside(openRowIds, collapsedOver);
  const effectiveExpanded = expanded || hasNewRow;
  return {
    expanded: effectiveExpanded,
    toggle: () => {
      setExpanded(!effectiveExpanded);
      setCollapsedOver(effectiveExpanded ? openRowIds : null);
    },
  };
}

function hasRowOutside(rowIds: readonly string[], known: readonly string[]): boolean {
  return rowIds.some((rowId) => !known.includes(rowId));
}

function AskUserQuestionChainCard(props: AskUserQuestionChainProps): JSX.Element | null {
  const { groups, changeDraft } = useChainGroups(props);
  const { activeIndex, activate } = useChainActiveIndex(props.workspaceId, groups);
  const { submit, isSubmitting, submitError } = useChainSubmit(props.workspaceId, groups);
  useReleaseClosedRows(props, isSubmitting);
  const { expanded, toggle } = useChainExpansion(groups.map((group) => group.key));

  if (groups.length === 0) {
    return null;
  }

  return (
    <ToolContainer expanded={expanded}>
      <AskUserQuestionHeader
        expanded={expanded}
        onToggle={toggle}
        hint={ASK_USER_QUESTION_HINTS.nonBlocking.header}
        status={groups[0].row.status}
      />
      {expanded && (
        <ToolDetails>
          <div className="flex flex-col gap-3">
            <AskUserQuestionForm
              groups={groups}
              activeIndex={activeIndex}
              onActivate={activate}
              onDraftChange={changeDraft}
              onSubmit={submit}
              isSubmitting={isSubmitting}
              submitError={submitError}
              footerHint={ASK_USER_QUESTION_HINTS.nonBlocking.footer}
            />
          </div>
        </ToolDetails>
      )}
    </ToolContainer>
  );
}

/**
 * Every open non-blocking (Exec) question in the dock above the chat input, chained into one
 * form: one tab strip, one Summary and one Submit that sends all answers in one message, so the
 * agent is steered once instead of once per question set. Rendered even for one open call, so a
 * call that arrives while the user answers adds tabs to the mounted form instead of a new card.
 */
export function AskUserQuestionChain(props: AskUserQuestionChainProps): JSX.Element {
  return (
    // Keys the sticky expand preference like the single card's ToolMessage does.
    <ToolNameProvider toolName="ask_user_question">
      <AskUserQuestionChainCard {...props} />
    </ToolNameProvider>
  );
}
