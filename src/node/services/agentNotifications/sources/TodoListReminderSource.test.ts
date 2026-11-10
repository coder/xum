import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { setTodosForSessionDir } from "@/node/services/tools/todo";

import { TodoListReminderSource } from "./TodoListReminderSource";
import { nodeSessionFiles } from "@/node/services/sessionFiles/nodeSessionFiles";
import { nodeSessionLocks } from "@/node/services/sessionLocks/nodeSessionLocks";

describe("TodoListReminderSource", () => {
  const workspaceId = "ws-test";
  let workspaceSessionDir: string;

  beforeEach(async () => {
    workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-todos-"));
    await setTodosForSessionDir(
      workspaceId,
      workspaceSessionDir,
      [
        { content: "Completed", status: "completed" },
        { content: "In progress", status: "in_progress" },
        { content: "Pending", status: "pending" },
      ],
      nodeSessionLocks,
      nodeSessionFiles
    );
  });

  afterEach(async () => {
    await fs.rm(workspaceSessionDir, { recursive: true, force: true });
  });

  test("reminds after 5 tool calls, then every 10", async () => {
    const source = new TodoListReminderSource({
      sessionFiles: nodeSessionFiles,
      workspaceSessionDir,
    });

    for (let i = 0; i < 4; i += 1) {
      const notifications = await source.poll({ toolName: "bash", toolSucceeded: true, now: i });
      expect(notifications).toEqual([]);
    }

    const fifth = await source.poll({ toolName: "bash", toolSucceeded: true, now: 4 });
    expect(fifth.length).toBe(1);
    expect(fifth[0].content).toContain("5 tool calls");
    expect(fifth[0].content).toContain("- [>] In progress");

    for (let i = 0; i < 9; i += 1) {
      const notifications = await source.poll({
        toolName: "bash",
        toolSucceeded: true,
        now: 5 + i,
      });
      expect(notifications).toEqual([]);
    }

    const fifteenth = await source.poll({ toolName: "bash", toolSucceeded: true, now: 14 });
    expect(fifteenth.length).toBe(1);
    expect(fifteenth[0].content).toContain("15 tool calls");
  });

  test("resets after successful todo_write", async () => {
    const source = new TodoListReminderSource({
      sessionFiles: nodeSessionFiles,
      workspaceSessionDir,
    });

    for (let i = 0; i < 4; i += 1) {
      await source.poll({ toolName: "bash", toolSucceeded: true, now: i });
    }

    const write = await source.poll({ toolName: "todo_write", toolSucceeded: true, now: 100 });
    expect(write).toEqual([]);

    for (let i = 0; i < 4; i += 1) {
      const notifications = await source.poll({
        toolName: "bash",
        toolSucceeded: true,
        now: 200 + i,
      });
      expect(notifications).toEqual([]);
    }

    const fifthAfterReset = await source.poll({ toolName: "bash", toolSucceeded: true, now: 205 });
    expect(fifthAfterReset.length).toBe(1);
    expect(fifthAfterReset[0].content).toContain("5 tool calls");
  });

  test("suppresses reminder when todo list is empty", async () => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-todos-empty-"));
    const source = new TodoListReminderSource({
      sessionFiles: nodeSessionFiles,
      workspaceSessionDir: emptyDir,
    });

    try {
      for (let i = 0; i < 5; i += 1) {
        const notifications = await source.poll({ toolName: "bash", toolSucceeded: true, now: i });
        expect(notifications).toEqual([]);
      }
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });

  test("suppresses reminder when all todos are completed", async () => {
    await setTodosForSessionDir(
      workspaceId,
      workspaceSessionDir,
      [
        { content: "Done 1", status: "completed" },
        { content: "Done 2", status: "completed" },
      ],
      nodeSessionLocks,
      nodeSessionFiles
    );

    const source = new TodoListReminderSource({
      sessionFiles: nodeSessionFiles,
      workspaceSessionDir,
    });

    for (let i = 0; i < 5; i += 1) {
      const notifications = await source.poll({ toolName: "bash", toolSucceeded: true, now: i });
      expect(notifications).toEqual([]);
    }
  });
});
