import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
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

  test("pruneMissingWorkspaces drops unknown entries and keeps known ones", async () => {
    await service.updateRecency("known-workspace", 100);
    await service.updateRecency("stale-workspace", 200);
    await service.updateRecency("another-stale", 300);

    const prunedCount = await service.pruneMissingWorkspaces(() =>
      Promise.resolve(new Set(["known-workspace"]))
    );
    expect(prunedCount).toBe(2);

    const snapshots = await service.getAllSnapshots();
    expect(snapshots.get("known-workspace")?.recency).toBe(100);
    expect(snapshots.has("stale-workspace")).toBe(false);
    expect(snapshots.has("another-stale")).toBe(false);
  });

  test("pruneMissingWorkspaces preserves unrecognized fields on surviving entries", async () => {
    // Upgrade↔downgrade: a newer build may persist fields this build does not
    // know about; pruning stale siblings must not strip them.
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: {
          "known-workspace": {
            recency: 100,
            streaming: false,
            lastModel: null,
            lastThinkingLevel: null,
            agentStatus: null,
            fieldFromNewerBuild: { nested: true },
          },
          "stale-workspace": { recency: 200, streaming: false },
        },
      })
    );

    expect(
      await service.pruneMissingWorkspaces(() => Promise.resolve(new Set(["known-workspace"])))
    ).toBe(1);

    const persisted = JSON.parse(await readFile(filePath, "utf-8")) as ExtensionMetadataFile;
    expect(Object.keys(persisted.workspaces)).toEqual(["known-workspace"]);
    expect(
      (persisted.workspaces["known-workspace"] as { fieldFromNewerBuild?: unknown })
        .fieldFromNewerBuild
    ).toEqual({ nested: true });
  });

  test("pruneMissingWorkspaces fetches known ids only after loading the file", async () => {
    // The cross-process loss-safety argument (see the pruneMissingWorkspaces
    // doc comment) requires the known-ids fetch to observe every workspace
    // registration that preceded an entry visible in the loaded file — i.e.
    // load first, fetch second. Fetch-first would misclassify a concurrently
    // created workspace's fresh entry as stale.
    await service.updateRecency("known-workspace", 100);
    const order: string[] = [];
    const internals = service as unknown as ExtensionMetadataServiceInternals;
    const originalLoad = internals.load.bind(service);
    internals.load = async () => {
      order.push("load");
      return originalLoad();
    };
    try {
      await service.pruneMissingWorkspaces(() => {
        order.push("fetch-known-ids");
        return Promise.resolve(new Set(["known-workspace"]));
      });
    } finally {
      internals.load = originalLoad;
    }
    expect(order).toEqual(["load", "fetch-known-ids"]);
  });

  test("deleteWorkspace removes malformed falsy persisted entries", async () => {
    // Key presence, not truthiness: a null entry must not survive removal
    // (it would leak the key until the next process-start prune).
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: { "malformed-workspace": null, "other-workspace": { recency: 1 } },
      })
    );
    await service.deleteWorkspace("malformed-workspace");

    const persisted = JSON.parse(await readFile(filePath, "utf-8")) as ExtensionMetadataFile;
    expect("malformed-workspace" in persisted.workspaces).toBe(false);
    expect("other-workspace" in persisted.workspaces).toBe(true);
  });

  test("late writers cannot resurrect a deleted workspace entry", async () => {
    // Removal cannot drain every in-flight metadata producer (e.g. a
    // stream-abort's fire-and-forget stop-status write), so writes landing
    // after deleteWorkspace must not recreate the entry on disk.
    await service.updateRecency("removed-workspace", 100);
    await service.deleteWorkspace("removed-workspace");

    const lateStreaming = await service.setStreaming("removed-workspace", false, {
      hasTodos: false,
    });
    // Callers still get a computed snapshot; it just is not persisted.
    expect(lateStreaming.streaming).toBe(false);
    await service.updateRecency("removed-workspace", 200);
    await service.setTodoStatus("removed-workspace", { emoji: "x", message: "late" }, true);
    expect(
      await service.setSidebarStatus("removed-workspace", { emoji: "x", message: "late" })
    ).toBeNull();

    expect((await service.getAllSnapshots()).has("removed-workspace")).toBe(false);
    const persisted = JSON.parse(await readFile(filePath, "utf-8")) as ExtensionMetadataFile;
    expect(persisted.workspaces["removed-workspace"]).toBeUndefined();

    // Unrelated workspaces keep writing normally.
    await service.updateRecency("other-workspace", 300);
    expect((await service.getAllSnapshots()).get("other-workspace")?.recency).toBe(300);
  });

  test("pruneMissingWorkspaces preserves entries written by another process mid-prune", async () => {
    // XUM_ALLOW_MULTIPLE_INSTANCES: a second backend can register a fresh
    // workspace and complete its first metadata write between this pass's
    // snapshot load and its pruned rewrite. The deletion-only merge against a
    // fresh reload must preserve that entry instead of clobbering the file
    // with the pre-write snapshot.
    await service.updateRecency("known-workspace", 100);
    await service.updateRecency("stale-workspace", 200);

    const internals = service as unknown as ExtensionMetadataServiceInternals;
    const originalLoad = internals.load.bind(service);
    let foreignWriteInjected = false;
    internals.load = async () => {
      const data = await originalLoad();
      if (!foreignWriteInjected) {
        foreignWriteInjected = true;
        // Simulate the foreign process's write landing after our snapshot.
        const foreign = await originalLoad();
        foreign.workspaces["foreign-new"] = {
          recency: 300,
          streaming: false,
          lastModel: null,
          lastThinkingLevel: null,
          agentStatus: null,
        };
        await writeFile(filePath, JSON.stringify(foreign));
      }
      return data;
    };
    try {
      expect(
        await service.pruneMissingWorkspaces(() => Promise.resolve(new Set(["known-workspace"])))
      ).toBe(1);
    } finally {
      internals.load = originalLoad;
    }

    const persisted = JSON.parse(await readFile(filePath, "utf-8")) as ExtensionMetadataFile;
    expect(persisted.workspaces["foreign-new"]).toBeDefined();
    expect(persisted.workspaces["known-workspace"]).toBeDefined();
    expect(persisted.workspaces["stale-workspace"]).toBeUndefined();
  });

  test("late writers cannot resurrect entries reclaimed by pruneMissingWorkspaces", async () => {
    await service.updateRecency("stale-workspace", 100);
    await service.pruneMissingWorkspaces(() => Promise.resolve(new Set<string>()));

    await service.updateRecency("stale-workspace", 200);
    expect((await service.getAllSnapshots()).has("stale-workspace")).toBe(false);
  });

  test("a writer enqueued while the prune is mid-fetch cannot resurrect a reclaimed entry", async () => {
    // The prune publishes tombstones only while its queued mutation runs. A
    // writer that passes its pre-queue tombstone check during the prune's
    // known-ids fetch enqueues BEHIND the prune, so only the in-queue
    // re-check stops it from recreating the entry the prune just reclaimed.
    await service.updateRecency("stale-workspace", 100);
    let releaseKnownIds!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseKnownIds = resolve;
    });
    const prune = service.pruneMissingWorkspaces(async () => {
      await gate;
      return new Set<string>();
    });
    const lateWriter = service.updateRecency("stale-workspace", 200);
    releaseKnownIds();
    expect(await prune).toBe(1);
    await lateWriter;

    expect((await service.getAllSnapshots()).has("stale-workspace")).toBe(false);
    const persisted = JSON.parse(await readFile(filePath, "utf-8")) as ExtensionMetadataFile;
    expect(persisted.workspaces["stale-workspace"]).toBeUndefined();
  });

  test("pruneMissingWorkspaces does not rewrite the file when nothing is stale", async () => {
    // Compact (non-pretty) serialization: any rewrite through save() would
    // change the raw bytes, so byte-equality proves no write happened.
    const rawContent = JSON.stringify({
      version: 1,
      workspaces: {
        "known-workspace": { recency: 100, streaming: false },
      },
    });
    await writeFile(filePath, rawContent);

    expect(
      await service.pruneMissingWorkspaces(() => Promise.resolve(new Set(["known-workspace"])))
    ).toBe(0);
    expect(await readFile(filePath, "utf-8")).toBe(rawContent);
  });
});
