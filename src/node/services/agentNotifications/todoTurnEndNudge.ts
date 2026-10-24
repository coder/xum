import type { CompletedMessagePart } from "@/common/types/stream";
import { TURN_STOP_PROMPT_MAX_CHARS } from "@/node/services/agentPlugins/promptHooks";
import { isSuccessfulToolResult } from "@/node/services/aiServiceEventGuards";
import type { SessionFiles } from "@/node/services/sessionFiles/sessionFiles";
import { readTodosForSessionDir } from "@/node/services/todos/todoStorage";
import { TODO_TURN_END_NUDGE } from "@/common/utils/machineTurnPrompts";

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

export interface TurnStopContinuation {
  prompt: string;
}

/** The turn.stop continuation from the plugin hooks' prompt and the nudge, or null for none. */
export function mergeTurnStopContinuation(input: {
  hookPrompt: string | null;
  todoNudge: boolean;
}): TurnStopContinuation | null {
  if (!input.todoNudge) return input.hookPrompt == null ? null : { prompt: input.hookPrompt };
  // Every continuation, the nudge included, keeps the turn's tools: a nudge limited to todo_write
  // left work the model could do open until the next user message ("Gating and pushing needs
  // bash, and this turn has only todo_write"), so the nudged turn may continue normally.
  if (input.hookPrompt == null) return { prompt: TODO_TURN_END_NUDGE };
  // The joined prompt keeps the cap: the plugin's part is cut, so the nudge always arrives whole.
  const separator = "\n\n";
  const hookRoom = TURN_STOP_PROMPT_MAX_CHARS - separator.length - TODO_TURN_END_NUDGE.length;
  return {
    prompt: `${input.hookPrompt.slice(0, hookRoom)}${separator}${TODO_TURN_END_NUDGE}`,
  };
}
