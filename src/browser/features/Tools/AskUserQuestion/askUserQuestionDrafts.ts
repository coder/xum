import assert from "@/common/utils/assert";

import type { AskUserQuestionQuestion } from "@/common/types/tools";
import type { AskUserQuestionSelection } from "@/common/utils/tools/askUserQuestionSummary";

// The answering form's draft model, shared by the single question card and the dock's chained
// form over several open question sets.

export const OTHER_VALUE = "__other__";

export interface DraftAnswer {
  selected: string[];
  otherText: string;
}

export type DraftAnswers = Record<string, DraftAnswer>;

export const EMPTY_DRAFT: DraftAnswer = { selected: [], otherText: "" };

interface CachedState {
  draftAnswers: DraftAnswers;
  activeIndex: number;
}

// Cache draft state per question row so it survives workspace switches. Keyed by workspace and
// row, not by tool call id alone: forks copy rows, and providers may reuse a tool call id.
const draftStateCache = new Map<string, CachedState>();

export function getDraftStateKey(props: {
  workspaceId?: string;
  rowId?: string;
  toolCallId: string;
}): string {
  return JSON.stringify([props.workspaceId ?? null, props.rowId ?? null, props.toolCallId]);
}

export function getCachedDraftState(key: string): CachedState | undefined {
  return draftStateCache.get(key);
}

export function setCachedDraftState(key: string, state: CachedState): void {
  draftStateCache.set(key, state);
}

export function deleteCachedDraftState(key: string): void {
  draftStateCache.delete(key);
}

function parsePrefilledAnswer(question: AskUserQuestionQuestion, answer: string): DraftAnswer {
  const trimmed = answer.trim();
  if (trimmed.length === 0) {
    return { selected: [], otherText: "" };
  }

  const optionLabels = new Set(question.options.map((o) => o.label));

  if (!question.multiSelect) {
    if (optionLabels.has(trimmed)) {
      return { selected: [trimmed], otherText: "" };
    }

    return { selected: [OTHER_VALUE], otherText: trimmed };
  }

  const tokens = trimmed
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const selected: string[] = [];
  const otherParts: string[] = [];

  for (const token of tokens) {
    if (optionLabels.has(token)) {
      selected.push(token);
    } else {
      otherParts.push(token);
    }
  }

  if (otherParts.length > 0) {
    selected.push(OTHER_VALUE);
  }

  return { selected, otherText: otherParts.join(", ") };
}

/** The drafts a fresh form starts from: the call's prefilled `answers`, else nothing picked. */
export function createInitialDrafts(
  questions: readonly AskUserQuestionQuestion[],
  argsAnswers: Record<string, string> | null | undefined
): DraftAnswers {
  const initial: DraftAnswers = {};
  for (const q of questions) {
    const prefilled = argsAnswers?.[q.question];
    initial[q.question] =
      typeof prefilled === "string"
        ? parsePrefilledAnswer(q, prefilled)
        : { selected: [], otherText: "" };
  }
  return initial;
}

export function isQuestionAnswered(draft: DraftAnswer | undefined): draft is DraftAnswer {
  if (draft == null || draft.selected.length === 0) {
    return false;
  }

  if (draft.selected.includes(OTHER_VALUE)) {
    return draft.otherText.trim().length > 0;
  }

  return true;
}

export function draftToAnswerString(question: AskUserQuestionQuestion, draft: DraftAnswer): string {
  assert(isQuestionAnswered(draft), "draftToAnswerString requires a complete answer");

  const parts = draft.selected.map((label) =>
    label === OTHER_VALUE ? draft.otherText.trim() : label
  );

  if (!question.multiSelect) {
    assert(parts.length === 1, "Single-select questions must have exactly one answer");
    return parts[0];
  }

  return parts.join(", ");
}

/**
 * The form's picks as 1-based option numbers plus the user's own text. A non-blocking answer is
 * built from these, never from the flattened answer string, where a label plus Other text can
 * read like another label.
 */
export function buildAnswerSelections(
  questions: readonly AskUserQuestionQuestion[],
  draftAnswers: DraftAnswers
): AskUserQuestionSelection[] {
  return questions.map((q) => {
    const draft = draftAnswers[q.question];
    if (!isQuestionAnswered(draft)) {
      return { optionNumbers: [], otherText: "" };
    }
    return {
      optionNumbers: draft.selected
        .map((label) => q.options.findIndex((option) => option.label === label) + 1)
        .filter((optionNumber) => optionNumber > 0),
      otherText: draft.selected.includes(OTHER_VALUE) ? draft.otherText : "",
    };
  });
}

/** The answers keyed by question text; unanswered questions get an empty string. */
export function buildAnswersRecord(
  questions: readonly AskUserQuestionQuestion[],
  draftAnswers: DraftAnswers
): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const q of questions) {
    const draft = draftAnswers[q.question];
    answers[q.question] = isQuestionAnswered(draft) ? draftToAnswerString(q, draft) : "";
  }
  return answers;
}

/**
 * Get descriptions for selected answer labels from a question's options.
 * Filters out "Other" and labels not found in options.
 */
export function getDescriptionsForLabels(
  question: AskUserQuestionQuestion,
  labels: string[]
): string[] {
  return labels
    .filter((label) => label !== OTHER_VALUE)
    .map((label) => question.options.find((o) => o.label === label)?.description)
    .filter((d): d is string => d !== undefined);
}

export function applyDraftEdit(
  current: DraftAnswers,
  question: string,
  update: (draft: DraftAnswer) => DraftAnswer
): DraftAnswers {
  return { ...current, [question]: update(current[question] ?? EMPTY_DRAFT) };
}

/**
 * Clicking an option: multi-select toggles it; single-select replaces the pick (clearing the
 * Other text unless Other was picked), and clicking the picked option clears it.
 */
export function toggleDraftOption(
  question: AskUserQuestionQuestion,
  draft: DraftAnswer,
  label: string
): DraftAnswer {
  if (question.multiSelect) {
    const selected = new Set(draft.selected);
    if (selected.has(label)) {
      selected.delete(label);
    } else {
      selected.add(label);
    }
    return { ...draft, selected: Array.from(selected) };
  }
  return {
    selected: draft.selected.includes(label) ? [] : [label],
    otherText: label === OTHER_VALUE ? draft.otherText : "",
  };
}
