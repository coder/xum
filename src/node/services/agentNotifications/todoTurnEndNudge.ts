import type { CompletedMessagePart } from "@/common/types/stream";
import {
  joinTurnStopReasons,
  TURN_STOP_PROMPT_MAX_CHARS,
} from "@/node/services/agentPlugins/promptHooks";
import type { TurnStopContinueReason } from "@/node/services/events/eventSpine";
import { isSuccessfulToolResult } from "@/node/services/aiServiceEventGuards";
import type { SessionFiles } from "@/node/services/sessionFiles/sessionFiles";
import { readTodosForSessionDir } from "@/node/services/todos/todoStorage";
import { TODO_TURN_END_NUDGE, TURN_END_NUDGE_SEPARATOR } from "@/common/utils/machineTurnPrompts";

// The prompt text lives in common code so the transcript can render it as a compact row.
export { TODO_TURN_END_NUDGE };

/** A todo_write call that ran and succeeded; a refused or failed call is not a list write. */
function isSuccessfulTodoWrite(call: { toolName: string; state: string; output?: unknown }) {
  return (
    call.toolName === "todo_write" &&
    call.state === "output-available" &&
    isSuccessfulToolResult(call.output)
  );
}

/**
 * Whether the ending stream earns the nudge: a todo_write call succeeded and the list still has a pending
 * or in-progress item. False (no extra model step) for turns that never called todo_write, so
 * they cost no todo read either.
 */
export async function needsTodoTurnEndNudge(input: {
  sessionDir: string;
  parts: readonly CompletedMessagePart[];
  /** The session files that todo_write writes (the memory volume in the in-memory loop). */
  files: SessionFiles;
}): Promise<boolean> {
  const wroteTodos = input.parts.some(
    (part) =>
      part.type === "dynamic-tool" &&
      (isSuccessfulTodoWrite(part) ||
        // Programmatic tool calling runs todo_write inside code_execution.
        part.nestedCalls?.some(isSuccessfulTodoWrite) === true)
  );
  if (!wroteTodos) return false;

  const todos = await readTodosForSessionDir(input.sessionDir, input.files);
  return todos.some((todo) => todo.status !== "completed");
}

/**
 * Whether a message the user sent starts the stream that is about to run: a manual send that is
 * not synthetic. Only those turns earn the nudge. A transcript audit (2026-10-25, 571 nudges) found
 * that machine wakes (monitor matches, sub-agent reports, heartbeats, peer messages, goal
 * continuations) caused about 90% of nudges. Their open items almost always wait on purpose, so the
 * nudged turn only repeated the wait. Each wake counts as its own user turn, so a coordinator got
 * one nudge per wake.
 *
 * Compaction requests and their follow-ups are automatic, so they start machine turns too: a user
 * turn that compacts loses its one nudge. Inheriting the earlier origin instead mislabeled wakes
 * that compacted before their send, and skipping one nudge is cheaper than nudging a machine turn.
 */
export function streamStartedByUserMessage(input: {
  automatic: boolean;
  synthetic: boolean;
}): boolean {
  return !input.automatic && !input.synthetic;
}

/**
 * streamStartedByUserMessage for a resumed stream (no new message). An automatic resume that is
 * not a retry is a machine wake, such as the prompt-free resume after a sub-agent report. An
 * automatic retry and a manual resume (Retry, an answered question) continue the current turn.
 */
export function resumedStreamStartedByUserMessage(input: {
  previous: boolean;
  automatic: boolean;
  retry: boolean;
}): boolean {
  return input.automatic && !input.retry ? false : input.previous;
}

export interface TurnStopContinuation {
  prompt: string;
  /** The hookKey of each hook whose reason text is in the prompt, each once (none for nudges). */
  hookKeys: string[];
  /** Those hooks' plugins, each once, in chain order. */
  pluginNames: string[];
}

/**
 * The turn.stop continuation from the plugin hooks' reasons and Xum's nudges (TODO first, then
 * the status page), or null for none.
 */
export function mergeTurnStopContinuation(input: {
  hookReasons: readonly TurnStopContinueReason[];
  nudges: readonly string[];
}): TurnStopContinuation | null {
  // Every continuation, a nudge included, keeps the turn's tools: a nudge limited to todo_write
  // left work the model could do open until the next user message ("Gating and pushing needs
  // bash, and this turn has only todo_write"), so the nudged turn may continue normally.
  const nudgePrompt = input.nudges.join(TURN_END_NUDGE_SEPARATOR);
  // The joined prompt keeps the cap: the plugin's part is cut, so the nudges always arrive whole.
  const hookRoom =
    input.nudges.length === 0
      ? TURN_STOP_PROMPT_MAX_CHARS
      : TURN_STOP_PROMPT_MAX_CHARS - TURN_END_NUDGE_SEPARATOR.length - nudgePrompt.length;
  const hooks = joinTurnStopReasons(input.hookReasons, hookRoom);
  const prompt = [hooks.prompt, nudgePrompt]
    .filter((part) => part.length > 0)
    .join(TURN_END_NUDGE_SEPARATOR);
  return prompt.length > 0 ? { ...hooks, prompt } : null;
}
