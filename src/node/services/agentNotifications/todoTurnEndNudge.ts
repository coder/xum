import type { CompletedMessagePart } from "@/common/types/stream";
import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";
import type { SendMessageOptions } from "@/common/orpc/types";
import { TURN_STOP_PROMPT_MAX_CHARS } from "@/node/services/agentPlugins/promptHooks";
import { readTodosForSessionDir } from "@/node/services/todos/todoStorage";

/**
 * The turn-end todo nudge. TodoListReminderSource only speaks inside tool results, from the 5th
 * tool call after a todo_write on, so a model that writes a list, makes a few calls and then
 * ends its turn with text leaves the pinned list stale (pstack dogfood: "1 in progress, 5
 * pending" after a finished fix). AgentSession sends this prompt as a turn.stop continuation, at
 * most once per user turn, so the model can bring the list up to date before the turn ends.
 *
 * The prompt is constant on purpose: the todo text is model-written (a prompt injection can put
 * instructions there), so it must not come back as a user row. The model already sees its own
 * todo_write calls in context.
 */
export const TODO_TURN_END_NUDGE = `<notification>
You ended your turn, but your TODO list still has pending or in-progress items. Update it now with todo_write so it matches what you actually did: mark finished items completed and remove items you dropped. If an item is still open on purpose, keep it and say why in one sentence. Do not start new work.
</notification>`;

/**
 * The tool policy of a nudge-only continuation: todo_write and nothing else, so the extra turn
 * cannot run commands or edit files. Appended to the caller policy, so it narrows the agent's.
 */
export const TODO_TURN_END_NUDGE_TOOL_POLICY: ToolPolicy = [
  { regex_match: ".*", action: "disable" },
  { regex_match: "todo_write", action: "enable" },
];

/**
 * Whether the ending stream earns the nudge: it called todo_write and the list still has a pending
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
      (part.toolName === "todo_write" ||
        // Programmatic tool calling runs todo_write inside code_execution.
        part.nestedCalls?.some((call) => call.toolName === "todo_write") === true)
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
