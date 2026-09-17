import { tool } from "ai";
import * as fs from "fs/promises";
import * as path from "path";
import writeFileAtomic from "@/node/utils/writeFileAtomic";
import assert from "@/common/utils/assert";
import type { ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { TodoItem } from "@/common/types/tools";
import { MAX_TODOS } from "@/common/constants/toolLimits";
import { getTodoFilePath, readTodosForSessionDir } from "@/node/services/todos/todoStorage";
import { workspaceFileLocks } from "@/node/utils/concurrency/workspaceFileLocks";

/**
 * Validate todo sequencing rules before persisting.
 * Enforces order: completed → in_progress → pending (top to bottom)
 * Enforces maximum count to encourage summarization.
 */
function validateTodos(todos: TodoItem[]): void {
  if (!Array.isArray(todos)) {
    throw new Error("Invalid todos payload: expected an array");
  }

  if (todos.length === 0) {
    return;
  }

  // Enforce maximum TODO count
  if (todos.length > MAX_TODOS) {
    throw new Error(
      `Too many TODOs (${todos.length}/${MAX_TODOS}). ` +
        `Keep high precision at the center: ` +
        `summarize old completed work (e.g., 'Setup phase (3 tasks)'), ` +
        `keep recent completions detailed (1-2), ` +
        `in_progress tasks in the middle, ` +
        `immediate pending detailed (2-3), ` +
        `and summarize far future work (e.g., 'Testing phase (4 items)').`
    );
  }

  let phase: "completed" | "in_progress" | "pending" = "completed";

  todos.forEach((todo, index) => {
    const status = todo.status;

    switch (status) {
      case "completed": {
        if (phase !== "completed") {
          throw new Error(
            `Invalid todo order at index ${index}: completed tasks must appear before in-progress or pending tasks`
          );
        }
        // Stay in completed phase
        break;
      }
      case "in_progress": {
        if (phase === "pending") {
          throw new Error(
            `Invalid todo order at index ${index}: in-progress tasks must appear before pending tasks`
          );
        }
        // Transition to in_progress phase (from completed or stay in in_progress)
        phase = "in_progress";
        break;
      }
      case "pending": {
        // Transition to pending phase (from completed, in_progress, or stay in pending)
        phase = "pending";
        break;
      }
      default: {
        throw new Error(`Invalid todo status at index ${index}: ${String(status)}`);
      }
    }
  });
}

/**
 * Write todos to the workspace session directory.
 */
async function writeTodos(
  workspaceId: string,
  workspaceSessionDir: string,
  todos: TodoItem[]
): Promise<void> {
  validateTodos(todos);

  await workspaceFileLocks.withLock(workspaceId, async () => {
    const todoFile = getTodoFilePath(workspaceSessionDir);
    await fs.mkdir(path.dirname(todoFile), { recursive: true });
    await writeFileAtomic(todoFile, JSON.stringify(todos, null, 2));
  });
}

async function clearTodos(workspaceId: string, workspaceSessionDir: string): Promise<void> {
  await workspaceFileLocks.withLock(workspaceId, async () => {
    const todoFile = getTodoFilePath(workspaceSessionDir);
    try {
      await fs.unlink(todoFile);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
  });
}

/**
 * Todo write tool factory
 * Creates a tool that allows the AI to create/update the todo list
 */
export const createTodoWriteTool: ToolFactory = (config) => {
  return tool({
    description: TOOL_DEFINITIONS.todo_write.description,
    inputSchema: TOOL_DEFINITIONS.todo_write.schema,
    execute: async ({ todos }) => {
      assert(config.workspaceId, "todo_write requires workspaceId");
      assert(config.workspaceSessionDir, "todo_write requires workspaceSessionDir");
      await writeTodos(config.workspaceId, config.workspaceSessionDir, todos);
      return {
        success: true as const,
        count: todos.length,
      };
    },
  });
};

/**
 * Todo read tool factory
 * Creates a tool that allows the AI to read the current todo list
 */
export const createTodoReadTool: ToolFactory = (config) => {
  return tool({
    description: TOOL_DEFINITIONS.todo_read.description,
    inputSchema: TOOL_DEFINITIONS.todo_read.schema,
    execute: async () => {
      assert(config.workspaceSessionDir, "todo_read requires workspaceSessionDir");
      const todos = await readTodosForSessionDir(config.workspaceSessionDir);
      return {
        todos,
      };
    },
  });
};

/**
 * Set todos for a workspace session directory (useful for testing)
 */
export async function setTodosForSessionDir(
  workspaceId: string,
  workspaceSessionDir: string,
  todos: TodoItem[]
): Promise<void> {
  await writeTodos(workspaceId, workspaceSessionDir, todos);
}

/**
 * Get todos for a workspace session directory (useful for testing)
 */
export async function getTodosForSessionDir(workspaceSessionDir: string): Promise<TodoItem[]> {
  return readTodosForSessionDir(workspaceSessionDir);
}

/**
 * Clear todos for a workspace session directory (useful for testing and cleanup)
 */
export async function clearTodosForSessionDir(
  workspaceId: string,
  workspaceSessionDir: string
): Promise<void> {
  await clearTodos(workspaceId, workspaceSessionDir);
}
