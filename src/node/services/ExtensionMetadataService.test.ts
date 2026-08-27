import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import * as path from "path";
import { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { ExtensionMetadataFile } from "@/node/utils/extensionMetadata";

const PREFIX = "mux-extension-metadata-test-";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

interface ExtensionMetadataServiceInternals {
  load: () => Promise<ExtensionMetadataFile>;
}

const addLoadDelay = (target: ExtensionMetadataService, delayMs: number): (() => void) => {
  const internals = target as unknown as ExtensionMetadataServiceInternals;
  const originalLoad = internals.load.bind(target);

  internals.load = async () => {
    const data = await originalLoad();
    await sleep(delayMs);
    return data;
  };

  return () => {
    internals.load = originalLoad;
  };
};

describe("ExtensionMetadataService", () => {
  let tempDir: string;
  let filePath: string;
  let service: ExtensionMetadataService;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), PREFIX));
    filePath = path.join(tempDir, "extensionMetadata.json");
    service = new ExtensionMetadataService(filePath);
    await service.initialize();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("updateRecency persists timestamp and getAllSnapshots mirrors it", async () => {
    const snapshot = await service.updateRecency("workspace-1", 123);
    expect(snapshot.recency).toBe(123);
    expect(snapshot.streaming).toBe(false);
    expect(snapshot.lastModel).toBeNull();
    expect(snapshot.lastThinkingLevel).toBeNull();

    const snapshots = await service.getAllSnapshots();
    expect(snapshots.get("workspace-1")).toEqual(snapshot);
  });

  test("setAgentStatus persists transient display status payload", async () => {
    const displayStatus = { emoji: "🤔", message: "Deciding execution strategy" };

    const snapshot = await service.setAgentStatus("workspace-display-status", displayStatus);
    expect(snapshot.displayStatus).toEqual(displayStatus);

    const cleared = await service.setAgentStatus("workspace-display-status", null);
    expect(cleared.displayStatus).toBeUndefined();
  });

  test("clearing transient display status also clears legacy carried-over status", async () => {
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: {
          "workspace-display-status-clear": {
            recency: 123,
            streaming: false,
            lastModel: null,
            lastThinkingLevel: null,
            agentStatus: { emoji: "🔧", message: "Legacy background status" },
          },
        },
      }),
      "utf-8"
    );

    await service.setAgentStatus("workspace-display-status-clear", {
      emoji: "🤔",
      message: "Deciding execution strategy",
    });
    const cleared = await service.setAgentStatus("workspace-display-status-clear", null);

    expect(cleared.displayStatus).toBeUndefined();
    expect(cleared.todoStatus).toBeUndefined();
  });

  test("setTodoStatus persists todo-derived progress and clears it when the list empties", async () => {
    const todoStatus = { emoji: "🔄", message: "Running checks" };

    const withTodos = await service.setTodoStatus("workspace-todos", todoStatus, true);
    expect(withTodos.todoStatus).toEqual(todoStatus);
    expect(withTodos.hasTodos).toBe(true);

    const cleared = await service.setTodoStatus("workspace-todos", null, false);
    expect(cleared.todoStatus).toBeUndefined();
    expect(cleared.hasTodos).toBe(false);

    const snapshots = await service.getAllSnapshots();
    expect(snapshots.get("workspace-todos")?.todoStatus).toBeUndefined();
    expect(snapshots.get("workspace-todos")?.hasTodos).toBe(false);
  });

  test("setSidebarStatus round-trips the dedup input hash and clears it with the status", async () => {
    const status = { emoji: "🛠️", message: "Editing source" };

    const snapshot = await service.setSidebarStatus("ws-hash", status, { inputHash: "hash-1" });
    expect(await service.getSidebarStatusInputHash("ws-hash")).toBe("hash-1");
    // Backend-only field: must not leak into the IPC snapshot shape.
    expect(snapshot).not.toHaveProperty("sidebarStatusInputHash");

    // A status written without a hash invalidates any stale one.
    await service.setSidebarStatus("ws-hash", status);
    expect(await service.getSidebarStatusInputHash("ws-hash")).toBeNull();

    await service.setSidebarStatus("ws-hash", status, { inputHash: "hash-2" });
    await service.setSidebarStatus("ws-hash", null);
    expect(await service.getSidebarStatusInputHash("ws-hash")).toBeNull();
  });

  test("a todo-path clear orphans the hash and the reader treats it as absent", async () => {
    await service.setSidebarStatus(
      "ws-hash",
      { emoji: "🛠️", message: "Editing source" },
      { inputHash: "hash-1" }
    );
    expect(await service.getSidebarStatusInputHash("ws-hash")).toBe("hash-1");

    // setTodoStatus clears the shared todoStatus slot without touching the
    // hash; the reader must not hand back a hash with no status behind it.
    await service.setTodoStatus("ws-hash", null, false);
    expect(await service.getSidebarStatusInputHash("ws-hash")).toBeNull();
  });

  test("sidebar status input hash survives unrelated metadata mutations", async () => {
    // Mutators round-trip entries through coerceExtensionMetadata; dropping
    // the hash there would silently reintroduce regenerate-on-restart after
    // any recency/streaming/todo write.
    await service.setSidebarStatus(
      "ws-hash",
      { emoji: "🛠️", message: "Editing source" },
      { inputHash: "hash-1" }
    );

    await service.updateRecency("ws-hash", 500);
    await service.setStreaming("ws-hash", true, { model: "anthropic:claude-haiku-4-5" });
    await service.setTodoStatus("ws-hash", { emoji: "🔄", message: "Running checks" }, true);

    expect(await service.getSidebarStatusInputHash("ws-hash")).toBe("hash-1");
  });

  test("concurrent cross-workspace mutations preserve both workspace entries", async () => {
    const restoreLoad = addLoadDelay(service, 20);
    try {
      await Promise.all([
        service.updateRecency("ws-A", 100),
        service.setStreaming("ws-B", true, {
          model: "anthropic/sonnet",
          thinkingLevel: "medium",
        }),
      ]);
    } finally {
      restoreLoad();
    }

    const snapshots = await service.getAllSnapshots();
    expect(snapshots.size).toBe(2);

    const workspaceA = snapshots.get("ws-A");
    expect(workspaceA).not.toBeUndefined();
    expect(workspaceA?.recency).toBe(100);
    expect(workspaceA?.streaming).toBe(false);

    const workspaceB = snapshots.get("ws-B");
    expect(workspaceB).not.toBeUndefined();
    expect(workspaceB?.streaming).toBe(true);
    expect(workspaceB?.lastModel).toBe("anthropic/sonnet");
    expect(workspaceB?.lastThinkingLevel).toBe("medium");
  });

  test("serializes many concurrent cross-workspace mutations without clobbering", async () => {
    const restoreLoad = addLoadDelay(service, 20);
    try {
      await Promise.all([
        service.updateRecency("ws-1", 101),
        service.setStreaming("ws-2", true, { model: "anthropic/sonnet" }),
        service.setTodoStatus("ws-3", { emoji: "🔄", message: "Working" }, true),
        service.updateRecency("ws-4", 404),
        service.setStreaming("ws-5", false),
        service.setTodoStatus("ws-6", null, false),
        service.updateRecency("ws-7", 707),
        service.setStreaming("ws-8", true, {
          model: "openai/gpt-5",
          thinkingLevel: "high",
        }),
      ]);
    } finally {
      restoreLoad();
    }

    const snapshots = await service.getAllSnapshots();
    expect(snapshots.size).toBe(8);
    expect(snapshots.get("ws-1")?.recency).toBe(101);
    expect(snapshots.get("ws-2")?.lastModel).toBe("anthropic/sonnet");
    expect(snapshots.get("ws-3")?.todoStatus).toEqual({ emoji: "🔄", message: "Working" });
    expect(snapshots.get("ws-4")?.recency).toBe(404);
    expect(snapshots.get("ws-5")?.streaming).toBe(false);
    expect(snapshots.get("ws-6")?.todoStatus).toBeUndefined();
    expect(snapshots.get("ws-7")?.recency).toBe(707);
    expect(snapshots.get("ws-8")?.lastThinkingLevel).toBe("high");
  });

  test("legacy agentStatus is projected into todoStatus when todoStatus is absent", async () => {
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: {
          "workspace-legacy-status": {
            recency: 123,
            streaming: false,
            lastModel: null,
            lastThinkingLevel: null,
            agentStatus: { emoji: "🔧", message: "Legacy background status" },
          },
        },
      }),
      "utf-8"
    );

    const snapshots = await service.getAllSnapshots();
    expect(snapshots.get("workspace-legacy-status")?.todoStatus).toEqual({
      emoji: "🔧",
      message: "Legacy background status",
    });
  });

  test("malformed todoStatus falls back to legacy agentStatus when todos were never explicitly cleared", async () => {
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: {
          "workspace-malformed-todo-status": {
            recency: 123,
            streaming: false,
            lastModel: null,
            lastThinkingLevel: null,
            todoStatus: { nope: true },
            agentStatus: { emoji: "🔧", message: "Legacy background status" },
          },
        },
      }),
      "utf-8"
    );

    const snapshots = await service.getAllSnapshots();
    expect(snapshots.get("workspace-malformed-todo-status")?.todoStatus).toEqual({
      emoji: "🔧",
      message: "Legacy background status",
    });
  });

  test("legacy agentStatus does not repopulate todoStatus after an explicit empty todo snapshot", async () => {
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: {
          "workspace-cleared-legacy-status": {
            recency: 123,
            streaming: false,
            lastModel: null,
            lastThinkingLevel: null,
            agentStatus: { emoji: "🔧", message: "Legacy background status" },
            hasTodos: false,
          },
        },
      }),
      "utf-8"
    );

    const snapshots = await service.getAllSnapshots();
    expect(snapshots.get("workspace-cleared-legacy-status")?.todoStatus).toBeUndefined();
    expect(snapshots.get("workspace-cleared-legacy-status")?.hasTodos).toBe(false);
  });

  test("toSnapshot coerces malformed hasTodos to undefined", async () => {
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: {
          "workspace-bad-todos": {
            recency: 123,
            streaming: false,
            lastModel: null,
            lastThinkingLevel: null,
            agentStatus: null,
            hasTodos: "yes",
          },
        },
      }),
      "utf-8"
    );

    const snapshots = await service.getAllSnapshots();
    expect(snapshots.get("workspace-bad-todos")?.hasTodos).toBeUndefined();
  });

  test("updateRecency self-heals malformed workspace entries", async () => {
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: {
          "workspace-bad-entry": false,
        },
      }),
      "utf-8"
    );

    const snapshot = await service.updateRecency("workspace-bad-entry", 321);
    expect(snapshot).toEqual({
      recency: 321,
      streaming: false,
      goal: null,
      lastModel: null,
      lastThinkingLevel: null,
    });

    const snapshots = await service.getAllSnapshots();
    expect(snapshots.get("workspace-bad-entry")).toEqual(snapshot);
  });

  test("setStreaming round-trips hasTodos when provided", async () => {
    const withoutTodos = await service.setStreaming("workspace-has-todos", false, {
      hasTodos: false,
    });
    expect(withoutTodos.hasTodos).toBe(false);

    const withTodos = await service.setStreaming("workspace-has-todos", false, {
      hasTodos: true,
    });
    expect(withTodos.hasTodos).toBe(true);

    const snapshots = await service.getAllSnapshots();
    expect(snapshots.get("workspace-has-todos")?.hasTodos).toBe(true);
  });

  test("setStreaming toggles status and remembers last model", async () => {
    await service.updateRecency("workspace-2", 200);
    const streaming = await service.setStreaming("workspace-2", true, {
      model: "anthropic/sonnet",
      thinkingLevel: "high",
    });
    expect(streaming.streaming).toBe(true);
    expect(streaming.lastModel).toBe("anthropic/sonnet");
    expect(streaming.lastThinkingLevel).toBe("high");

    const cleared = await service.setStreaming("workspace-2", false);
    expect(cleared.streaming).toBe(false);
    expect(cleared.lastModel).toBe("anthropic/sonnet");
    expect(cleared.lastThinkingLevel).toBe("high");

    const snapshots = await service.getAllSnapshots();
    expect(snapshots.get("workspace-2")).toEqual(cleared);
  });
});
