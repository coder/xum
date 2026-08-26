import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
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

  test("pruneMissingWorkspaces spares ids re-registered mid-prune", async () => {
    // With multiple instances, a downgraded backend can re-register a
    // deterministic legacy id (and write its activity) between the prune's
    // enumeration and its deletion pass. The recheck against a second fresh
    // enumeration must spare that entry and lift its write tombstone —
    // deleting on the stale classification would destroy data a later
    // tombstone-clear cannot restore.
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: {
          "known-workspace": { recency: 100, streaming: false },
          "revived-workspace": { recency: 200, streaming: false },
        },
      })
    );
    let fetches = 0;
    const prunedCount = await service.pruneMissingWorkspaces(() => {
      fetches += 1;
      // First enumeration: revived-workspace looks stale. Recheck: it was
      // re-registered concurrently.
      return Promise.resolve(
        fetches === 1
          ? new Set(["known-workspace"])
          : new Set(["known-workspace", "revived-workspace"])
      );
    });

    expect(prunedCount).toBe(0);
    const persisted = JSON.parse(await readFile(filePath, "utf-8")) as ExtensionMetadataFile;
    expect(Object.keys(persisted.workspaces).sort()).toEqual([
      "known-workspace",
      "revived-workspace",
    ]);
    // Tombstone lifted: subsequent writes for the revived id persist.
    expect(service.isWorkspaceDeleted("revived-workspace")).toBe(false);
  });

  test("a newer build's metadata version is unsupported, never quarantined or self-healed", async () => {
    // Downgrade safety: a syntactically valid file with version !== 1 was
    // written by a newer schema. Quarantining/resetting it (or a lenient
    // writer self-healing to {} and saving version-1 bytes over it) would
    // make the upgrade back find an empty canonical file and lose all
    // activity state. Both read modes must propagate and leave the bytes
    // untouched.
    const newerFile = JSON.stringify({ version: 2, workspaces: {}, futureField: true });
    await writeFile(filePath, newerFile);

    // Strict read: retryable failure, no quarantine.
    let strictError: unknown = null;
    try {
      await service.getAllSnapshots({ throwOnError: true });
    } catch (error) {
      strictError = error;
    }
    expect(strictError).not.toBeNull();

    // Lenient write: the mutation fails instead of clobbering the file.
    let writeError: unknown = null;
    try {
      await service.updateRecency("ws-1", 123);
    } catch (error) {
      writeError = error;
    }
    expect(writeError).not.toBeNull();

    // Bytes untouched, no sidecar created.
    expect(await readFile(filePath, "utf-8")).toBe(newerFile);
    const sidecarExists = await readFile(`${filePath}.corrupt`, "utf-8").then(
      () => true,
      () => false
    );
    expect(sidecarExists).toBe(false);
  });

  test("a strict read resumes a crash-interrupted quarantine of corrupt bytes", async () => {
    // Crash window: quarantine renamed main -> sidecar and died before
    // writing the empty replacement. The next strict read must finish the
    // recovery — never return an authoritative {} while the main path is
    // missing, and never keep failing until an unrelated writer saves.
    await writeFile(`${filePath}.corrupt`, "{not json");
    // Main file intentionally absent (beforeEach never creates it).

    // The moved bytes really were corrupt: recovery resets the main path to
    // a valid empty file and keeps the bytes quarantined for inspection.
    expect((await service.getAllSnapshots({ throwOnError: true })).size).toBe(0);
    expect(await readFile(`${filePath}.corrupt`, "utf-8")).toBe("{not json");
    expect(JSON.parse(await readFile(filePath, "utf-8"))).toEqual({
      version: 1,
      workspaces: {},
    });
  });

  test("an ENOENT read races a completed recovery in another process and re-reads", async () => {
    // Post-recovery TOCTOU: our read hits ENOENT while another process holds
    // the file mid-quarantine, and by the time we probe for the sidecar that
    // process has already restored the healthy main file AND consumed the
    // sidecar. The absent sidecar proves nothing about the stale ENOENT —
    // load must re-read the main path instead of returning authoritative {}.
    const healthy = {
      version: 1,
      workspaces: { "ws-1": { recency: 42, streaming: false } },
    };
    // Main file intentionally absent at first read (beforeEach never creates
    // it). Simulate the other process's completed recovery at probe time.
    const internals = service as unknown as {
      probeQuarantineSidecar: () => Promise<boolean>;
    };
    const originalProbe = internals.probeQuarantineSidecar.bind(service);
    internals.probeQuarantineSidecar = async () => {
      // The concurrent process restored the healthy file and unlinked the
      // sidecar before our probe ran.
      await writeFile(filePath, JSON.stringify(healthy));
      internals.probeQuarantineSidecar = originalProbe;
      return false;
    };

    const snapshots = await service.getAllSnapshots({ throwOnError: true });
    expect(snapshots.get("ws-1")?.recency).toBe(42);
  });

  test("a failing sidecar probe keeps a missing-main read retryable", async () => {
    // Main file absent and the sidecar probe fails with EACCES: the
    // sidecar's existence is unknowable, so the read must not resolve as an
    // authoritative empty file — recoverable metadata may sit in the
    // unprobeable sidecar. Only a verified ENOENT counts as absence.
    const internals = service as unknown as {
      probeQuarantineSidecar: () => Promise<boolean>;
    };
    internals.probeQuarantineSidecar = () => {
      const error = new Error("permission denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      return Promise.reject(error);
    };

    let strictError: unknown = null;
    try {
      await service.getAllSnapshots({ throwOnError: true });
    } catch (error) {
      strictError = error;
    }
    expect(strictError).not.toBeNull();
  });

  test("a lenient writer completes a crash-interrupted quarantine instead of clobbering it", async () => {
    // Same crash window as above, but hit by a normal (lenient) mutation.
    // Treating it as an empty file would save a partial one-entry file at
    // the main path — and the pending restore (deliberately no-overwrite)
    // would then strand every other workspace's metadata in the sidecar.
    // The writer must instead complete the recovery inline and apply its
    // mutation on top of the restored data.
    const healthy = {
      version: 1,
      workspaces: { "ws-other": { recency: 42, streaming: false } },
    };
    await writeFile(`${filePath}.corrupt`, JSON.stringify(healthy));
    // Main file intentionally absent (beforeEach never creates it).

    await service.updateRecency("ws-new", 100);

    const persisted = JSON.parse(await readFile(filePath, "utf-8")) as ExtensionMetadataFile;
    expect(Object.keys(persisted.workspaces).sort()).toEqual(["ws-new", "ws-other"]);
    // Sidecar consumed by the restore.
    const sidecarGone = await readFile(`${filePath}.corrupt`, "utf-8").then(
      () => false,
      () => true
    );
    expect(sidecarGone).toBe(true);
  });

  test("recovery restores an unsupported-version sidecar instead of resetting it", async () => {
    // A newer build's file can end up in the sidecar (crash-interrupted
    // quarantine on a downgraded install, or a newer backend saving between
    // the corruption check and the rename). It is preserved data, not
    // corruption: recovery must put it back at the main path — installing
    // the empty version-1 reset would hand the newer build an empty
    // canonical file and lose all its activity state.
    const newerFile = JSON.stringify({ version: 2, workspaces: {}, futureField: true });
    await writeFile(`${filePath}.corrupt`, newerFile);
    // Main file intentionally absent (crash window).

    let strictError: unknown = null;
    try {
      await service.getAllSnapshots({ throwOnError: true });
    } catch (error) {
      strictError = error;
    }
    // The restored file still fails the CURRENT build's read — but with the
    // non-destructive unsupported-version signal, not an empty reset.
    expect(strictError).not.toBeNull();
    expect(await readFile(filePath, "utf-8")).toBe(newerFile);
    const sidecarGone = await readFile(`${filePath}.corrupt`, "utf-8").then(
      () => false,
      () => true
    );
    expect(sidecarGone).toBe(true);
  });

  test("recovery reconciles a partial main file recreated during the crash window", async () => {
    // An older backend can observe the missing-main window as an empty file
    // and save a PARTIAL snapshot before recovery restores the sidecar.
    // EEXIST is not success: the sidecar's other entries must be merged into
    // the recreated file (main wins per key) instead of being abandoned.
    const sidecar = {
      version: 1,
      workspaces: { "ws-other": { recency: 42, streaming: false } },
    };
    await writeFile(`${filePath}.corrupt`, JSON.stringify(sidecar));
    // Main file intentionally absent; the probe hook below recreates it as a
    // partial file mid-recovery (modeling the concurrent older backend).
    const internals = service as unknown as {
      probeQuarantineSidecar: () => Promise<boolean>;
    };
    const originalProbe = internals.probeQuarantineSidecar.bind(service);
    internals.probeQuarantineSidecar = async () => {
      await writeFile(
        filePath,
        JSON.stringify({
          version: 1,
          workspaces: { "ws-new": { recency: 300, streaming: false } },
        })
      );
      internals.probeQuarantineSidecar = originalProbe;
      return true;
    };

    const snapshots = await service.getAllSnapshots({ throwOnError: true });
    expect(snapshots.get("ws-new")?.recency).toBe(300);
    expect(snapshots.get("ws-other")?.recency).toBe(42);
    // Sidecar consumed by the reconcile.
    const sidecarGone = await readFile(`${filePath}.corrupt`, "utf-8").then(
      () => false,
      () => true
    );
    expect(sidecarGone).toBe(true);
  });

  test("reconcile restores an unsupported-version sidecar over a recreated partial main", async () => {
    // Downgrade-overlap variant of the reconcile: a NEWER build's schema is
    // stranded in the sidecar while an older-schema backend recreates a
    // partial main during the crash window. Accepting the partial file would
    // lose the newer data permanently — nothing re-inspects the sidecar once
    // the main path exists, and a later quarantine's rename would destroy
    // it. The newer bytes must win the canonical path; the recreated file is
    // preserved as its own leftover.
    const newerFile = JSON.stringify({ version: 2, workspaces: {}, futureField: true });
    await writeFile(`${filePath}.corrupt`, newerFile);
    // Main file intentionally absent; the probe hook recreates it as a
    // partial version-1 file mid-recovery (modeling the older backend).
    const partial = JSON.stringify({
      version: 1,
      workspaces: { "ws-partial": { recency: 300, streaming: false } },
    });
    const internals = service as unknown as {
      probeQuarantineSidecar: () => Promise<boolean>;
    };
    const originalProbe = internals.probeQuarantineSidecar.bind(service);
    internals.probeQuarantineSidecar = async () => {
      await writeFile(filePath, partial);
      internals.probeQuarantineSidecar = originalProbe;
      return true;
    };

    let strictError: unknown = null;
    try {
      await service.getAllSnapshots({ throwOnError: true });
    } catch (error) {
      strictError = error;
    }
    // The swapped-in file still fails the CURRENT build's read — but with
    // the non-destructive unsupported-version signal, not the partial data.
    expect(strictError).not.toBeNull();
    expect(await readFile(filePath, "utf-8")).toBe(newerFile);
    expect(await readFile(`${filePath}.recreated`, "utf-8")).toBe(partial);
    const sidecarGone = await readFile(`${filePath}.corrupt`, "utf-8").then(
      () => false,
      () => true
    );
    expect(sidecarGone).toBe(true);
  });

  test("an unreadable sidecar keeps reconcile retryable instead of accepting the partial main", async () => {
    // Transient I/O failure reading the sidecar during reconcile: reporting
    // success would make the read accept the recreated partial main while
    // the (possibly healthy) sidecar is never inspected again. A directory
    // at the sidecar path yields a deterministic errno (EISDIR) standing in
    // for EACCES/EIO-class failures.
    await mkdir(`${filePath}.corrupt`);
    const partial = JSON.stringify({
      version: 1,
      workspaces: { "ws-partial": { recency: 300, streaming: false } },
    });
    const internals = service as unknown as {
      probeQuarantineSidecar: () => Promise<boolean>;
    };
    const originalProbe = internals.probeQuarantineSidecar.bind(service);
    internals.probeQuarantineSidecar = async () => {
      await writeFile(filePath, partial);
      internals.probeQuarantineSidecar = originalProbe;
      return true;
    };

    let strictError: unknown = null;
    try {
      await service.getAllSnapshots({ throwOnError: true });
    } catch (error) {
      strictError = error;
    }
    expect(strictError).not.toBeNull();
    expect((strictError as NodeJS.ErrnoException).code).toBe("EISDIR");
    // Once the sidecar becomes readable (here: gone), the retry proceeds.
    await rm(`${filePath}.corrupt`, { recursive: true });
    const snapshots = await service.getAllSnapshots({ throwOnError: true });
    expect(snapshots.get("ws-partial")?.recency).toBe(300);
  });

  test("a strict read reconciles a leftover sidecar next to a recreated valid main", async () => {
    // Crash between quarantine's rename and its completion, then another
    // backend recreates a VALID partial main from the missing-main window
    // before this process starts: no read ever sees ENOENT or corruption,
    // so without the once-per-process sidecar check the full snapshot would
    // stay stranded in the sidecar forever.
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: { "ws-new": { recency: 300, streaming: false } },
      })
    );
    await writeFile(
      `${filePath}.corrupt`,
      JSON.stringify({
        version: 1,
        workspaces: { "ws-other": { recency: 42, streaming: false } },
      })
    );
    // Fresh instance: models the restarted process.
    const restarted = new ExtensionMetadataService(filePath);

    const snapshots = await restarted.getAllSnapshots({ throwOnError: true });
    expect(snapshots.get("ws-new")?.recency).toBe(300);
    expect(snapshots.get("ws-other")?.recency).toBe(42);
    // Sidecar consumed by the reconcile.
    const sidecarGone = await readFile(`${filePath}.corrupt`, "utf-8").then(
      () => false,
      () => true
    );
    expect(sidecarGone).toBe(true);
  });

  test("an unprobeable sidecar during resumed recovery keeps the strict read retryable", async () => {
    // The once-per-process leftover check found the sidecar, but the
    // re-probe INSIDE the queued recovery transiently fails (EACCES/EIO
    // class): reporting it absent would accept the recreated partial main
    // and never look at the sidecar again for the process lifetime. The
    // failure must propagate (latch reset) so a later read reconciles.
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: { "ws-new": { recency: 300, streaming: false } },
      })
    );
    await writeFile(
      `${filePath}.corrupt`,
      JSON.stringify({
        version: 1,
        workspaces: { "ws-other": { recency: 42, streaming: false } },
      })
    );
    const restarted = new ExtensionMetadataService(filePath);
    const internals = restarted as unknown as {
      probeQuarantineSidecar: () => Promise<boolean>;
    };
    const originalProbe = internals.probeQuarantineSidecar.bind(restarted);
    let probeCalls = 0;
    internals.probeQuarantineSidecar = async () => {
      probeCalls += 1;
      if (probeCalls === 2) {
        // Second probe = the one inside resumeQuarantineRecovery's queue.
        internals.probeQuarantineSidecar = originalProbe;
        const error = new Error("probe blocked") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return originalProbe();
    };

    let strictError: unknown = null;
    try {
      await restarted.getAllSnapshots({ throwOnError: true });
    } catch (error) {
      strictError = error;
    }
    expect((strictError as NodeJS.ErrnoException | null)?.code).toBe("EACCES");
    // Latch was reset: the retry probes again and reconciles the sidecar.
    const snapshots = await restarted.getAllSnapshots({ throwOnError: true });
    expect(snapshots.get("ws-new")?.recency).toBe(300);
    expect(snapshots.get("ws-other")?.recency).toBe(42);
  });

  test("a registration probe clears a stale tombstone and lets the write persist", async () => {
    await service.updateRecency("ws-1", 100);
    await service.deleteWorkspace("ws-1");
    // No probe wired: tombstones stay strictly write-suppressing.
    await service.updateRecency("ws-1", 200);
    expect((await service.getAllSnapshots()).has("ws-1")).toBe(false);
    // Probe reporting the id NOT registered: still suppressed.
    let registered = false;
    service.setRegistrationProbe(() => Promise.resolve(registered));
    await service.updateRecency("ws-1", 300);
    expect((await service.getAllSnapshots()).has("ws-1")).toBe(false);
    expect(service.isWorkspaceDeleted("ws-1")).toBe(true);
    // Re-registered (e.g. by a downgraded concurrent backend): the write
    // must persist without waiting for an activity bootstrap, and the
    // tombstone lifts so broadcasts resume too.
    registered = true;
    await service.updateRecency("ws-1", 400);
    expect((await service.getAllSnapshots()).get("ws-1")?.recency).toBe(400);
    expect(service.isWorkspaceDeleted("ws-1")).toBe(false);
  });

  test("clearTombstonesForRegisteredIds only clears tombstones the evidence postdates", async () => {
    await service.updateRecency("ws-1", 100);
    // Evidence snapshot captured BEFORE the removal: a tombstone published
    // afterwards (same-process removal racing the activity list's evidence
    // reads) must survive stale evidence claiming the id is registered.
    const preEvidence = service.getTombstonedIds();
    await service.deleteWorkspace("ws-1");
    service.clearTombstonesForRegisteredIds(new Set(["ws-1"]), preEvidence);
    expect(service.isWorkspaceDeleted("ws-1")).toBe(true);
    // The next bootstrap snapshots the tombstone before its evidence reads,
    // so a genuinely re-registered id is cleared then.
    service.clearTombstonesForRegisteredIds(new Set(["ws-1"]), service.getTombstonedIds());
    expect(service.isWorkspaceDeleted("ws-1")).toBe(false);
  });

  test("a strict read restores healthy bytes stranded in the sidecar by a crashed quarantine", async () => {
    // The crash can also strand a HEALTHY file in the sidecar: a concurrent
    // writer repaired the main file right before quarantine's rename moved
    // it aside. Recovery must restore it — resetting to empty would discard
    // live activity data.
    const healthy = {
      version: 1,
      workspaces: { "ws-1": { recency: 42, streaming: false } },
    };
    await writeFile(`${filePath}.corrupt`, JSON.stringify(healthy));

    const snapshots = await service.getAllSnapshots({ throwOnError: true });
    expect(snapshots.get("ws-1")?.recency).toBe(42);
    // Restored to the main path (sidecar consumed by the restore).
    expect(JSON.parse(await readFile(filePath, "utf-8"))).toEqual(healthy);
  });
});
