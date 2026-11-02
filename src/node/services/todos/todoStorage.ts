import * as path from "path";

import type { TodoItem } from "@/common/types/tools";
import type { SessionFiles } from "@/node/services/sessionFiles/sessionFiles";

const TODO_FILE_NAME = "todos.json";

/**
 * Get path to todos.json file in the workspace's session directory.
 */
export function getTodoFilePath(workspaceSessionDir: string): string {
  return path.join(workspaceSessionDir, TODO_FILE_NAME);
}

export function coerceTodoItems(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const result: TodoItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;

    const content = (item as { content?: unknown }).content;
    const status = (item as { status?: unknown }).status;

    if (typeof content !== "string") continue;
    if (status !== "pending" && status !== "in_progress" && status !== "completed") continue;

    result.push({ content, status });
  }

  return result;
}

/**
 * Read todos from the workspace session directory. `files` is the session's SessionFiles (the
 * memory volume in the in-memory loop). Callers outside the loop keep the Node default.
 */
export async function readTodosForSessionDir(
  workspaceSessionDir: string,
  files: SessionFiles
): Promise<TodoItem[]> {
  const todoFile = getTodoFilePath(workspaceSessionDir);

  try {
    const content = await files.promises.readFile(todoFile, "utf-8");
    const parsed: unknown = JSON.parse(content);
    return coerceTodoItems(parsed);
  } catch (error) {
    // File doesn't exist yet or is invalid
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    return [];
  }
}
