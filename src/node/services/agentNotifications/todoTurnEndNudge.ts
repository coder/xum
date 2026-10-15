import type { CompletedMessagePart } from "@/common/types/stream";
import { renderTodoItemsAsMarkdownList } from "@/common/utils/todoList";
import { readTodosForSessionDir } from "@/node/services/todos/todoStorage";

/**
 * The turn-end todo nudge. TodoListReminderSource only speaks inside tool results, from the 5th
 * tool call after a todo_write on, so a model that writes a list, makes a few calls and then
 * ends its turn with text leaves the pinned list stale (pstack dogfood: "1 in progress, 5
 * pending" after a finished fix). AgentSession sends this prompt as a turn.stop continuation, at
 * most once per user turn, so the model can bring the list up to date before the turn ends.
 *
 * Returns null (no nudge, no extra model step) when the ending stream never called todo_write, so
 * turns that do not use the list cost nothing, or when no item is pending or in progress.
 */
export async function buildTodoTurnEndNudge(input: {
  sessionDir: string;
  parts: readonly CompletedMessagePart[];
}): Promise<string | null> {
  const wroteTodos = input.parts.some(
    (part) =>
      part.type === "dynamic-tool" &&
      (part.toolName === "todo_write" ||
        // Programmatic tool calling runs todo_write inside code_execution.
        part.nestedCalls?.some((call) => call.toolName === "todo_write") === true)
  );
  if (!wroteTodos) return null;

  const todos = await readTodosForSessionDir(input.sessionDir);
  if (todos.every((todo) => todo.status === "completed")) return null;

  return `<notification>
You ended your turn, but your TODO list still has pending or in-progress items. Update it now with todo_write so it matches what you actually did: mark finished items completed and remove items you dropped. If an item is still open on purpose, keep it and say why in one sentence. Do not start new work.

Current TODO List:
${renderTodoItemsAsMarkdownList(todos)}
</notification>`;
}
