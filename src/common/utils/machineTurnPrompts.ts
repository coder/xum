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
 * The prompt is constant on purpose: the todo text is model-written (a prompt injection can put
 * instructions there), so it must not come back as a user row. The model already sees its own
 * todo_write calls in context.
 */
export const TODO_TURN_END_NUDGE = `<notification>
You ended your turn, but your TODO list still has pending or in-progress items. Update it with todo_write so it matches what you actually did: mark finished items completed and remove items you dropped. Then continue with the open items that are still in scope and that you can do now. If an item stays open on purpose, for example because it waits for the user, keep it and say why in one sentence.
</notification>`;

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
