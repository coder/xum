import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { readTodosForSessionDir } from "@/node/services/todos/todoStorage";
import { createTodoWriteTool, setTodosForSessionDir } from "./todo";
import { createTestToolConfig, mockToolCallOptions } from "./testHelpers";
import type { TodoItem } from "@/common/types/tools";
import { MAX_TODOS } from "@/common/constants/toolLimits";

/** A valid ordered list: about two thirds completed, one in progress, the rest pending. */
function buildTodos(count: number): TodoItem[] {
  const completed = Math.max(0, count - Math.ceil(count / 3));
  return Array.from({ length: count }, (_, index) => ({
    content: `Step ${index + 1}`,
    status: index < completed ? "completed" : index === completed ? "in_progress" : "pending",
  }));
}

describe("Todo Storage", () => {
  const workspaceId = "test-workspace";
  let workspaceSessionDir: string;

  beforeEach(async () => {
    workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "todo-session-test-"));
  });

  afterEach(async () => {
    await fs.rm(workspaceSessionDir, { recursive: true, force: true });
  });

  describe("setTodosForSessionDir", () => {
    it("should store todo list in temp directory", async () => {
      const todos: TodoItem[] = [
        {
          content: "Installed dependencies",
          status: "completed",
        },
        {
          content: "Writing tests",
          status: "in_progress",
        },
        {
          content: "Update documentation",
          status: "pending",
        },
      ];

      await setTodosForSessionDir(workspaceId, workspaceSessionDir, todos);

      const storedTodos = await readTodosForSessionDir(workspaceSessionDir);
      expect(storedTodos).toEqual(todos);
    });

    it("should replace entire todo list on update", async () => {
      // Create initial list
      const initialTodos: TodoItem[] = [
        {
          content: "Task 1",
          status: "pending",
        },
        {
          content: "Task 2",
          status: "pending",
        },
      ];

      await setTodosForSessionDir(workspaceId, workspaceSessionDir, initialTodos);

      // Replace with updated list
      const updatedTodos: TodoItem[] = [
        {
          content: "Task 1",
          status: "completed",
        },
        {
          content: "Task 2",
          status: "in_progress",
        },
        {
          content: "Task 3",
          status: "pending",
        },
      ];

      await setTodosForSessionDir(workspaceId, workspaceSessionDir, updatedTodos);

      // Verify list was replaced, not merged
      const storedTodos = await readTodosForSessionDir(workspaceSessionDir);
      expect(storedTodos).toEqual(updatedTodos);
    });

    it("should handle empty todo list", async () => {
      // Create initial list
      await setTodosForSessionDir(workspaceId, workspaceSessionDir, [
        {
          content: "Task 1",
          status: "pending",
        },
      ]);

      // Clear list
      await setTodosForSessionDir(workspaceId, workspaceSessionDir, []);

      const storedTodos = await readTodosForSessionDir(workspaceSessionDir);
      expect(storedTodos).toEqual([]);
    });

    it("should reject one item over MAX_TODOS with the count and summarization guidance", async () => {
      const tooManyTodos = buildTodos(MAX_TODOS + 1);

      const write = setTodosForSessionDir(workspaceId, workspaceSessionDir, tooManyTodos);
      await expect(write).rejects.toThrow(`Too many TODOs (${MAX_TODOS + 1}/${MAX_TODOS})`);
      await expect(
        setTodosForSessionDir(workspaceId, workspaceSessionDir, tooManyTodos)
      ).rejects.toThrow(/summarize old completed work/i);
      // A rejected write must leave the stored list untouched.
      expect(await readTodosForSessionDir(workspaceSessionDir)).toEqual([]);
    });

    it("should accept exactly MAX_TODOS items", async () => {
      const maxTodos = buildTodos(MAX_TODOS);

      await setTodosForSessionDir(workspaceId, workspaceSessionDir, maxTodos);
      expect(await readTodosForSessionDir(workspaceSessionDir)).toEqual(maxTodos);
    });

    it("should accept multiple in_progress tasks", async () => {
      const todos: TodoItem[] = [
        { content: "Step 1", status: "in_progress" },
        { content: "Step 2", status: "in_progress" },
      ];

      await setTodosForSessionDir(workspaceId, workspaceSessionDir, todos);
      expect(await readTodosForSessionDir(workspaceSessionDir)).toEqual(todos);
    });

    it("should accept mixed completed + multiple in_progress + pending", async () => {
      const todos: TodoItem[] = [
        { content: "Done task", status: "completed" },
        { content: "Parallel task A", status: "in_progress" },
        { content: "Parallel task B", status: "in_progress" },
        { content: "Parallel task C", status: "in_progress" },
        { content: "Next up", status: "pending" },
      ];

      await setTodosForSessionDir(workspaceId, workspaceSessionDir, todos);
      expect(await readTodosForSessionDir(workspaceSessionDir)).toEqual(todos);
    });

    it("should reject when in_progress tasks appear after pending", async () => {
      const invalidTodos: TodoItem[] = [
        {
          content: "Step 1",
          status: "pending",
        },
        {
          content: "Step 2",
          status: "in_progress",
        },
      ];

      await expect(
        setTodosForSessionDir(workspaceId, workspaceSessionDir, invalidTodos)
      ).rejects.toThrow(/in-progress tasks must appear before pending tasks/i);
    });

    it("should reject when completed tasks appear after in_progress", async () => {
      const invalidTodos: TodoItem[] = [
        {
          content: "Step 1",
          status: "in_progress",
        },
        {
          content: "Step 2",
          status: "completed",
        },
      ];

      await expect(
        setTodosForSessionDir(workspaceId, workspaceSessionDir, invalidTodos)
      ).rejects.toThrow(/completed tasks must appear before in-progress or pending tasks/i);
    });

    it("should allow all completed tasks without in_progress", async () => {
      const todos: TodoItem[] = [
        {
          content: "Step 1",
          status: "completed",
        },
        {
          content: "Step 2",
          status: "completed",
        },
      ];

      await setTodosForSessionDir(workspaceId, workspaceSessionDir, todos);
      expect(await readTodosForSessionDir(workspaceSessionDir)).toEqual(todos);
    });

    it("should create directory if it doesn't exist", async () => {
      // Use a non-existent nested directory path
      const nonExistentDir = path.join(os.tmpdir(), "todo-nonexistent-test", "nested", "path");

      try {
        const todos: TodoItem[] = [
          {
            content: "Test task",
            status: "pending",
          },
        ];

        // Should not throw even though directory doesn't exist
        await setTodosForSessionDir(workspaceId, nonExistentDir, todos);

        // Verify the file was created and is readable
        const retrievedTodos = await readTodosForSessionDir(nonExistentDir);
        expect(retrievedTodos).toEqual(todos);

        // Verify the directory was actually created
        const dirStats = await fs.stat(nonExistentDir);
        expect(dirStats.isDirectory()).toBe(true);
      } finally {
        // Clean up the created directory
        await fs.rm(path.join(os.tmpdir(), "todo-nonexistent-test"), {
          recursive: true,
          force: true,
        });
      }
    });
  });

  describe("readTodosForSessionDir", () => {
    it("should return empty array when no todos exist", async () => {
      const todos = await readTodosForSessionDir(workspaceSessionDir);
      expect(todos).toEqual([]);
    });

    it("should return current todo list", async () => {
      const todos: TodoItem[] = [
        {
          content: "Task 1",
          status: "completed",
        },
        {
          content: "Task 2",
          status: "in_progress",
        },
      ];

      await setTodosForSessionDir(workspaceId, workspaceSessionDir, todos);

      const retrievedTodos = await readTodosForSessionDir(workspaceSessionDir);
      expect(retrievedTodos).toEqual(todos);
    });
  });

  describe("workspace isolation", () => {
    it("should isolate todos between different session directories", async () => {
      const tempDir1 = await fs.mkdtemp(path.join(os.tmpdir(), "todo-test-1-"));
      const tempDir2 = await fs.mkdtemp(path.join(os.tmpdir(), "todo-test-2-"));

      try {
        // Create different todos in each temp directory
        const todos1: TodoItem[] = [
          {
            content: "Stream 1 task",
            status: "pending",
          },
        ];

        const todos2: TodoItem[] = [
          {
            content: "Stream 2 task",
            status: "pending",
          },
        ];

        await setTodosForSessionDir("ws-1", tempDir1, todos1);
        await setTodosForSessionDir("ws-2", tempDir2, todos2);

        // Verify each session directory has its own todos
        const retrievedTodos1 = await readTodosForSessionDir(tempDir1);
        const retrievedTodos2 = await readTodosForSessionDir(tempDir2);

        expect(retrievedTodos1).toEqual(todos1);
        expect(retrievedTodos2).toEqual(todos2);
      } finally {
        // Clean up
        await fs.rm(tempDir1, { recursive: true, force: true });
        await fs.rm(tempDir2, { recursive: true, force: true });
      }
    });
  });

  describe("todo_write tool", () => {
    it("accepts a 9-step playbook plus 6 task items without merging steps", async () => {
      // Playbook routers (pstack) copy every playbook step into the list before task items.
      // Literal list on purpose: it pins the size the cap must support, independent of MAX_TODOS.
      const playbookSteps = [
        "Read the task",
        "Explore the code",
        "Write the plan",
        "Implement",
        "Validate",
        "Dogfood",
        "Open the PR",
        "Babysit CI",
        "Report",
      ];
      const taskItems = [
        "Raise the cap",
        "Fix the panel scroll",
        "Add tests",
        "Add stories",
        "Run static-check",
        "Write the PR body",
      ];
      const todos: TodoItem[] = [
        ...playbookSteps.map((content) => ({ content, status: "completed" as const })),
        { content: taskItems[0], status: "in_progress" },
        ...taskItems.slice(1).map((content) => ({ content, status: "pending" as const })),
      ];
      expect(todos).toHaveLength(15);

      const tool = createTodoWriteTool(createTestToolConfig(workspaceSessionDir));
      const result: unknown = await tool.execute!({ todos }, mockToolCallOptions);

      expect(result).toEqual({ success: true, count: 15 });
      expect(await readTodosForSessionDir(workspaceSessionDir)).toEqual(todos);
    });
  });
});
