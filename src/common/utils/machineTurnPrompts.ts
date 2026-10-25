import type { TimelineEventKind } from "@/common/orpc/schemas/timeline";
import { WORKFLOW_RESULT_MESSAGE_OPENING_SENTENCE } from "@/common/utils/workflowRunMessages";

// Fallback openings used when specific muxMetadata is absent or only a persisted digest remains.
// Prompt producers and timeline classification share them so their wording cannot drift.
export const BASH_MONITOR_WAKE_HEADINGS = {
  matched: "A background bash monitor matched output.",
  lost: "Xum restarted and background bash monitors were lost.",
  mixed: "Background bash monitor updates (including monitors lost to a Xum restart).",
  // Do not reword existing headings above: persisted timeline rows classify by exact prefix.
  exited: "A monitored background bash process finished.",
  failed: "A background bash monitor failed at runtime.",
  mixedRuntimeFailure: "Background bash monitor updates (including runtime monitor failures).",
} as const;

export const BACKGROUND_WORK_WAKE_OPENINGS = {
  subagentsCompleted: "Background sub-agent task(s) have completed.",
  subagentsFailed: "Background sub-agent task(s) failed terminally and will not produce reports.",
  workspaceTurnsTerminal: "Background workspace turn(s) have reached a terminal state:",
  awaitableWorkActive: "You have active background ",
} as const;

/**
 * The turn-end todo nudge. TodoListReminderSource only speaks inside tool results, from the 5th
 * tool call after a todo_write on, so a model that writes a list, makes a few calls and then
 * ends its turn with text leaves the pinned list stale (pstack dogfood: "1 in progress, 5
 * pending" after a finished fix). AgentSession sends this prompt as a turn.stop continuation, at
 * most once per user turn, so the model can bring the list up to date and finish open items it
 * can still do. The nudged turn keeps the turn's tools, so it can continue normally.
 *
 * The "Do not start" sentence exists because a transcript audit (2026-10-25) found nudged turns
 * that started a step their own previous message said waits on a review or a merge.
 *
 * The prompt is constant on purpose: the todo text is model-written (a prompt injection can put
 * instructions there), so it must not come back as a user row. The model already sees its own
 * todo_write calls in context.
 */
export const TODO_TURN_END_NUDGE = `<notification>
You ended your turn, but your TODO list still has pending or in-progress items. First finish the open items that are still in scope and that you can do now. Do not start an item that you said waits on something. Then update the list with todo_write so it matches what you actually did: mark finished items completed and remove items you dropped. If an item stays open on purpose, for example because it waits for the user, keep it and say why in one sentence.
</notification>`;

/**
 * Earlier texts of the current nudge (the nudged turn kept its tools). Histories still hold them,
 * so the transcript keeps rendering those rows as the compact "current" nudge row.
 */
const EARLIER_TODO_TURN_END_NUDGES: readonly string[] = [
  // #7027
  `<notification>
You ended your turn, but your TODO list still has pending or in-progress items. First finish the open items that are still in scope and that you can do now. Then update the list with todo_write so it matches what you actually did: mark finished items completed and remove items you dropped. If an item stays open on purpose, for example because it waits for the user, keep it and say why in one sentence.
</notification>`,
];

/**
 * The nudge text that #6720 shipped (todo_write-only turns). Histories still hold it, so the
 * transcript keeps rendering those rows as the compact nudge row.
 */
export const LEGACY_TODO_TURN_END_NUDGES: readonly string[] = [
  `<notification>
You ended your turn, but your TODO list still has pending or in-progress items. Update it now with todo_write so it matches what you actually did: mark finished items completed and remove items you dropped. If an item is still open on purpose, keep it and say why in one sentence. Do not start new work.
</notification>`,
];

/**
 * Which turn-end TODO nudge `text` is exactly: "current" (the nudged turn keeps its tools and
 * finishes open items), "legacy" (a todo_write-only list update), or null for any other text.
 */
export function classifyTodoTurnEndNudgePrompt(text: string): "current" | "legacy" | null {
  if (text === TODO_TURN_END_NUDGE || EARLIER_TODO_TURN_END_NUDGES.includes(text)) return "current";
  return LEGACY_TODO_TURN_END_NUDGES.includes(text) ? "legacy" : null;
}

/**
 * The turn-end status page nudge of the Agent interface view. The user sees the agent's
 * status.html instead of the transcript, but agents often end whole turns without replacing the
 * seeded placeholder or updating the page, so AgentSession sends this prompt as a turn.stop
 * continuation, at most once per user turn, when the page is blank or still shows the placeholder,
 * or a turn that ran tools left it unchanged. Constant, like the TODO nudge: no model-written text.
 */
export const STATUS_PAGE_TURN_END_NUDGE = `<notification>
You ended your turn, but the status page the user sees instead of this chat is blank, still shows Xum's placeholder, or did not change this turn. Update $XUM_SCRATCH_DIR/artifacts/status.html in place now so it shows the current status, progress and results, and anything that waits on the user. Do not redo work you already did.
</notification>`;

/** Joins Xum's turn-end nudges (TODO first, then the status page) into one continuation. */
export const TURN_END_NUDGE_SEPARATOR = "\n\n";

/**
 * Which turn-end status page nudge `text` is exactly: "status-page" alone, "todo-and-status-page"
 * when it follows the TODO nudge in one continuation, or null for any other text.
 */
export function classifyStatusPageTurnEndNudgePrompt(
  text: string
): "status-page" | "todo-and-status-page" | null {
  if (text === STATUS_PAGE_TURN_END_NUDGE) return "status-page";
  // Any current TODO nudge text, earlier ones included: joined rows stored before the TODO
  // prompt's last change must keep their compact row.
  const statusSuffix = `${TURN_END_NUDGE_SEPARATOR}${STATUS_PAGE_TURN_END_NUDGE}`;
  return text.endsWith(statusSuffix) &&
    classifyTodoTurnEndNudgePrompt(text.slice(0, -statusSuffix.length)) === "current"
    ? "todo-and-status-page"
    : null;
}

const PROMPT_OPENINGS_BY_KIND: ReadonlyArray<{
  kind: TimelineEventKind;
  openings: readonly string[];
}> = [
  { kind: "turn.monitor_wake", openings: Object.values(BASH_MONITOR_WAKE_HEADINGS) },
  { kind: "workflow.result", openings: [WORKFLOW_RESULT_MESSAGE_OPENING_SENTENCE] },
  { kind: "turn.background_wake", openings: Object.values(BACKGROUND_WORK_WAKE_OPENINGS) },
];

/**
 * Classifies a machine-authored turn from its prompt text. Also used on persisted timeline rows,
 * whose digest is whitespace-collapsed and truncated to 120 characters, so every opening above must
 * stay single-spaced and shorter than that.
 */
export function classifyMachineTurnPromptKind(text: string): TimelineEventKind | null {
  const normalized = text.trimStart();
  for (const entry of PROMPT_OPENINGS_BY_KIND) {
    if (entry.openings.some((opening) => normalized.startsWith(opening))) {
      return entry.kind;
    }
  }
  return null;
}
