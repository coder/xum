import type { CompletedMessagePart } from "@/common/types/stream";
import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";
import type { SendMessageOptions } from "@/common/orpc/types";
import { TURN_STOP_PROMPT_MAX_CHARS } from "@/node/services/agentPlugins/promptHooks";
import { isSuccessfulToolResult } from "@/node/services/aiServiceEventGuards";
import { readTodosForSessionDir } from "@/node/services/todos/todoStorage";
import { TODO_TURN_END_NUDGE } from "@/common/utils/machineTurnPrompts";

// The prompt text lives in common code so the transcript can render it as a compact row.
export { TODO_TURN_END_NUDGE };

/**
 * The tool policy of a nudge-only continuation: todo_write and nothing else, so the extra turn
 * cannot run commands or edit files. Appended to the agent's policy, it only disables: it never
 * enables a tool, so an agent that denies todo_write keeps that deny.
 */
export const TODO_TURN_END_NUDGE_TOOL_POLICY: ToolPolicy = [
  { regex_match: "(?!todo_write$).*", action: "disable" },
];

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
}): Promise<boolean> {
  const wroteTodos = input.parts.some(
    (part) =>
      part.type === "dynamic-tool" &&
      (isSuccessfulTodoWrite(part) ||
        // Programmatic tool calling runs todo_write inside code_execution.
        part.nestedCalls?.some(isSuccessfulTodoWrite) === true)
  );
  if (!wroteTodos) return false;

  const todos = await readTodosForSessionDir(input.sessionDir);
  return todos.some((todo) => todo.status !== "completed");
}

export interface TurnStopContinuation {
  prompt: string;
  optionOverrides?: Pick<SendMessageOptions, "toolPolicy">;
}

/** The turn.stop continuation from the plugin hooks' prompt and the nudge, or null for none. */
export function mergeTurnStopContinuation(input: {
  hookPrompt: string | null;
  todoNudge: boolean;
  callerToolPolicy: ToolPolicy | undefined;
}): TurnStopContinuation | null {
  if (!input.todoNudge) return input.hookPrompt == null ? null : { prompt: input.hookPrompt };
  // A nudge alone narrows the turn's own policy to todo_write.
  if (input.hookPrompt == null) {
    return {
      prompt: TODO_TURN_END_NUDGE,
      optionOverrides: {
        toolPolicy: [...(input.callerToolPolicy ?? []), ...TODO_TURN_END_NUDGE_TOOL_POLICY],
      },
    };
  }
  // A plugin continuation keeps the turn's tools. The joined prompt keeps the cap: the plugin's
  // part is cut, so the nudge always arrives whole.
  const separator = "\n\n";
  const hookRoom = TURN_STOP_PROMPT_MAX_CHARS - separator.length - TODO_TURN_END_NUDGE.length;
  return {
    prompt: `${input.hookPrompt.slice(0, hookRoom)}${separator}${TODO_TURN_END_NUDGE}`,
  };
}
