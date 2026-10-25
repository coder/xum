import { describe, expect, spyOn, test } from "bun:test";
import type { Tool } from "ai";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import type { InitStateManager } from "@/node/services/initStateManager";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { buildSessionFiles } from "@/node/services/sessionFiles/buildSessionFiles.testHarness";
import { SessionFilesMemory } from "@/node/services/sessionFiles/memorySessionFiles.testHarness";
import { setTodosForSessionDir } from "@/node/services/tools/todo";
import {
  createMemoryHost,
  MEMORY_USER_HOME,
} from "@/node/services/hostFiles/memoryHostFiles.testHarness";

import { makeTestEffectRunner, TEST_CLOCK_START_MS } from "@/node/services/di/testEffectRunner";
import { NotificationEngine } from "@/node/services/agentNotifications/NotificationEngine";

import { MODEL_ONLY_TOOL_NOTIFICATIONS_FIELD } from "./internalToolResultFields";
import { getToolsForModel } from "./tools";
import { nodeSessionFiles } from "@/node/services/sessionFiles/nodeSessionFiles";
import { nodeSessionLocks } from "@/node/services/sessionLocks/nodeSessionLocks";

type ToolExecuteFn = (args?: unknown, options?: unknown) => Promise<unknown>;

function getExecute(tool: unknown): ToolExecuteFn {
  if (!tool || typeof tool !== "object" || !("execute" in tool)) {
    throw new Error("Tool is missing execute()");
  }

  const execute = (tool as { execute?: unknown }).execute;
  if (typeof execute !== "function") {
    throw new Error("Tool execute() is not a function");
  }

  return execute as ToolExecuteFn;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a plain object tool result");
  }

  return value as Record<string, unknown>;
}

describe("getToolsForModel - model-only notifications", () => {
  test("injects __mux_notifications into tool results after 5 tool calls", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-ws-"));

    try {
      await setTodosForSessionDir(
        "ws-1",
        workspaceSessionDir,
        [
          { content: "Completed", status: "completed" },
          { content: "In progress", status: "in_progress" },
          { content: "Pending", status: "pending" },
        ],
        nodeSessionLocks,
        nodeSessionFiles
      );

      const runtime = new LocalRuntime(process.cwd());
      const initStateManager = {
        waitForInit: () => Promise.resolve(),
      } as unknown as InitStateManager;

      const tools = await getToolsForModel(
        "noop:model",
        {
          cwd: process.cwd(),
          runtime,
          runtimeTempDir: "/tmp",
          workspaceSessionDir,
        },
        "ws-1",
        initStateManager
      );

      const todoReadExecute = getExecute(tools.todo_read);

      for (let i = 0; i < 4; i += 1) {
        const result = asRecord(await todoReadExecute());
        expect(MODEL_ONLY_TOOL_NOTIFICATIONS_FIELD in result).toBe(false);
      }

      const fifth = asRecord(await todoReadExecute());
      expect(Array.isArray(fifth[MODEL_ONLY_TOOL_NOTIFICATIONS_FIELD])).toBe(true);
      expect(String((fifth[MODEL_ONLY_TOOL_NOTIFICATIONS_FIELD] as unknown[])[0])).toContain(
        "Current TODO List"
      );
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });

  test("does not re-wrap cached MCP tools across getToolsForModel() calls", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-ws-"));

    try {
      await setTodosForSessionDir(
        "ws-1",
        workspaceSessionDir,
        [{ content: "In progress", status: "in_progress" }],
        nodeSessionLocks,
        nodeSessionFiles
      );

      const runtime = new LocalRuntime(process.cwd());
      const initStateManager = {
        waitForInit: () => Promise.resolve(),
      } as unknown as InitStateManager;

      const cachedMcpTool = {
        // eslint-disable-next-line @typescript-eslint/require-await
        execute: async () => ({ ok: true }),
      } as unknown as Tool;

      const tools1 = await getToolsForModel(
        "noop:model",
        {
          cwd: process.cwd(),
          runtime,
          runtimeTempDir: "/tmp",
          workspaceSessionDir,
        },
        "ws-1",
        initStateManager,
        undefined,
        { mcp_dummy: cachedMcpTool }
      );

      const execute1 = getExecute(tools1.mcp_dummy);
      for (let i = 0; i < 4; i += 1) {
        const result = asRecord(await execute1());
        expect(MODEL_ONLY_TOOL_NOTIFICATIONS_FIELD in result).toBe(false);
      }

      const tools2 = await getToolsForModel(
        "noop:model",
        {
          cwd: process.cwd(),
          runtime,
          runtimeTempDir: "/tmp",
          workspaceSessionDir,
        },
        "ws-1",
        initStateManager,
        undefined,
        { mcp_dummy: cachedMcpTool }
      );

      const execute2 = getExecute(tools2.mcp_dummy);
      for (let i = 0; i < 4; i += 1) {
        const result = asRecord(await execute2());
        expect(MODEL_ONLY_TOOL_NOTIFICATIONS_FIELD in result).toBe(false);
      }

      const fifth = asRecord(await execute2());
      expect(Array.isArray(fifth[MODEL_ONLY_TOOL_NOTIFICATIONS_FIELD])).toBe(true);
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });

  test("does not enable notification injection when workspaceSessionDir is missing", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const initStateManager = {
      waitForInit: () => Promise.resolve(),
    } as unknown as InitStateManager;

    const dummyTool = {
      // eslint-disable-next-line @typescript-eslint/require-await
      execute: async () => ({ ok: true }),
    } as unknown as Tool;

    const tools = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
      },
      "ws-1",
      initStateManager,
      undefined,
      { dummy: dummyTool }
    );

    const dummyExecute = getExecute(tools.dummy);

    for (let i = 0; i < 5; i += 1) {
      const result = asRecord(await dummyExecute());
      expect(MODEL_ONLY_TOOL_NOTIFICATIONS_FIELD in result).toBe(false);
    }
  });

  test("only attaches notifications to plain-object tool results", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-ws-"));

    try {
      await setTodosForSessionDir(
        "ws-1",
        workspaceSessionDir,
        [{ content: "In progress", status: "in_progress" }],
        nodeSessionLocks,
        nodeSessionFiles
      );

      const runtime = new LocalRuntime(process.cwd());
      const initStateManager = {
        waitForInit: () => Promise.resolve(),
      } as unknown as InitStateManager;

      const stringTool = {
        // eslint-disable-next-line @typescript-eslint/require-await
        execute: async () => "ok",
      } as unknown as Tool;

      const tools = await getToolsForModel(
        "noop:model",
        {
          cwd: process.cwd(),
          runtime,
          runtimeTempDir: "/tmp",
          workspaceSessionDir,
        },
        "ws-1",
        initStateManager,
        undefined,
        { string_tool: stringTool }
      );

      const stringExecute = getExecute(tools.string_tool);
      const todoReadExecute = getExecute(tools.todo_read);

      for (let i = 0; i < 4; i += 1) {
        const result = await stringExecute();
        expect(result).toBe("ok");
      }

      const fifth = asRecord(await todoReadExecute());
      expect(Array.isArray(fifth[MODEL_ONLY_TOOL_NOTIFICATIONS_FIELD])).toBe(true);
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });

  test("the reminder reads the list that todo_write left in the session's SessionFiles", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-ws-"));

    try {
      const initStateManager = {
        waitForInit: () => Promise.resolve(),
      } as unknown as InitStateManager;
      const tools = await getToolsForModel(
        "noop:model",
        {
          cwd: process.cwd(),
          runtime: new LocalRuntime(process.cwd()),
          runtimeTempDir: "/tmp",
          workspaceId: "ws-1",
          workspaceSessionDir,
          sessionFiles: buildSessionFiles(SessionFilesMemory),
        },
        "ws-1",
        initStateManager
      );

      await getExecute(tools.todo_write)(
        { todos: [{ content: "In progress", status: "in_progress" }] },
        { toolCallId: "todo-1", messages: [] }
      );
      const todoReadExecute = getExecute(tools.todo_read);
      for (let i = 0; i < 4; i += 1) {
        const result = asRecord(await todoReadExecute());
        expect(MODEL_ONLY_TOOL_NOTIFICATIONS_FIELD in result).toBe(false);
      }

      const fifth = asRecord(await todoReadExecute());
      expect(String((fifth[MODEL_ONLY_TOOL_NOTIFICATIONS_FIELD] as unknown[])[0])).toContain(
        "- [>] In progress"
      );
      expect(await fs.readdir(workspaceSessionDir)).toEqual([]);
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });

  test("the home clutter note reads the home of the HostFiles and HostPaths it was given", async () => {
    // The agent loop passes its host layers (phase 5): an entry that appears in the memory home
    // gets the note, and the Node home of the test process is never read.
    const host = createMemoryHost();
    const initStateManager = {
      waitForInit: () => Promise.resolve(),
    } as unknown as InitStateManager;
    const tools = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime: new LocalRuntime(process.cwd()),
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
        workspaceSessionDir: "/sessions/ws-1",
        sessionFiles: buildSessionFiles(SessionFilesMemory),
        hostFiles: host.files,
        hostPaths: host.paths,
        xumEnv: { XUM_RUNTIME: "local", XUM_SCRATCH_DIR: "/tmp/scratch" },
      },
      "ws-1",
      initStateManager
    );
    const todoReadExecute = getExecute(tools.todo_read);
    // The first call waits for the turn-start listing of the home.
    expect(MODEL_ONLY_TOOL_NOTIFICATIONS_FIELD in asRecord(await todoReadExecute())).toBe(false);

    await host.files.promises.writeFile(path.join(MEMORY_USER_HOME, "helper.sh"), "echo hi\n");

    const next = asRecord(await todoReadExecute());
    expect(String((next[MODEL_ONLY_TOOL_NOTIFICATIONS_FIELD] as unknown[])[0])).toContain(
      "`~/helper.sh`"
    );
  });

  test("a tool call polls the notification sources with the session clock's time", async () => {
    // The sources stamp and compare times on the session's HostClock, so the poll's `now` must
    // come from that clock too, not from Date.now() (#7282). The TestClock starts months before
    // wall time, so a wall-clock `now` fails here.
    const clock = makeTestEffectRunner();
    const pollSpy = spyOn(NotificationEngine.prototype, "pollAfterToolCall");
    try {
      const initStateManager = {
        waitForInit: () => Promise.resolve(),
      } as unknown as InitStateManager;
      const tools = await getToolsForModel(
        "noop:model",
        {
          cwd: process.cwd(),
          runtime: new LocalRuntime(process.cwd()),
          runtimeTempDir: "/tmp",
          workspaceId: "ws-1",
          workspaceSessionDir: "/sessions/ws-1",
          sessionFiles: buildSessionFiles(SessionFilesMemory),
          clock: clock.hostClock,
        },
        "ws-1",
        initStateManager
      );
      await getExecute(tools.todo_read)();
      expect(pollSpy.mock.calls.map(([ctx]) => ctx.now)).toEqual([TEST_CLOCK_START_MS]);
    } finally {
      pollSpy.mockRestore();
      await clock.dispose();
    }
  });
});
