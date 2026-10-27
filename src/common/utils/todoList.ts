import type { TodoItem } from "@/common/types/tools";

type TodoLikeStatus = TodoItem["status"];

interface TodoLikeItem {
  status: TodoLikeStatus;
}

export interface TodoStatusSummary {
  emoji: "✓" | "🔄" | "○";
  message: string;
}

export function renderTodoItemsAsMarkdownList(todos: TodoItem[]): string {
  return todos
    .map((todo) => {
      const statusMarker =
        todo.status === "completed" ? "[x]" : todo.status === "in_progress" ? "[>]" : "[ ]";
      return `- ${statusMarker} ${todo.content}`;
    })
    .join("\n");
}

/** A plan with every step done: the TODO chip reads 5/5 until the next turn starts. */
export function isTodoListFinished(todos: readonly TodoLikeItem[]): boolean {
  return todos.length > 0 && todos.every((todo) => todo.status === "completed");
}

/**
 * Sidebar and landing-card status should reflect the most actionable todo item,
 * so we surface in-progress work first, then the next pending task, and finally
 * the most recent completion while the finished list is still visible.
 */
export function deriveTodoStatus(todos: readonly TodoItem[]): TodoStatusSummary | undefined {
  const inProgressTodo = todos.find((todo) => todo.status === "in_progress");
  if (inProgressTodo) {
    return { emoji: "🔄", message: inProgressTodo.content };
  }

  const pendingTodo = todos.find((todo) => todo.status === "pending");
  if (pendingTodo) {
    return { emoji: "○", message: pendingTodo.content };
  }

  for (let index = todos.length - 1; index >= 0; index--) {
    const todo = todos[index];
    if (todo.status === "completed") {
      return { emoji: "✓", message: todo.content };
    }
  }

  return undefined;
}

/**
 * `propose_plan` ends the active planning turn immediately, so any in-progress
 * todo steps need to flip to completed even though the model does not get a
 * follow-up turn to call `todo_write` again.
 */
export function completeInProgressTodoItems<T extends TodoLikeItem>(todos: T[]): T[] {
  let changed = false;
  const nextTodos = todos.map((todo) => {
    if (todo.status !== "in_progress") {
      return todo;
    }

    changed = true;
    return { ...todo, status: "completed" };
  });

  return changed ? nextTodos : todos;
}
