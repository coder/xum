import type { TurnCoordinator } from "./turnCoordinator";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { describe, expect, test, mock, beforeEach, afterEach, spyOn } from "bun:test";
import type { WorkspaceService } from "./workspaceService";
import { STARTUP_RECOVERY_CONCURRENCY } from "./workspaceService";
import type { AgentSession } from "./agentSession";
import { createAgentSessionHarness } from "./agentSession.testHarness";
import { existsSync } from "fs";
import * as fsPromises from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { Err, Ok, type Result } from "@/common/types/result";
import { SCRATCH_PROJECT_CONFIG_KEY } from "@/common/constants/scratch";
import { Config, type Workspace as WorkspaceConfigEntry } from "@/node/config";
import type { AIService } from "./aiService";
import { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { FrontendWorkspaceMetadata, WorkspaceMetadata } from "@/common/types/workspace";
import { makeAgentTaskIntegrationFake } from "./taskWorkspaceSeam.testUtils";
import { createMuxMessage } from "@/common/types/message";
import { projectWorkspace, saveWorkspaces } from "./taskService.testHarness";
import {
  createCompactionAdmissionMocks,
  createDeferred,
  createMockAIService,
  createWorkspaceServiceForTest,
  createWorkspaceServiceHarness,
  type WorkspaceServiceHarness,
} from "./workspaceService.testHarness";
import { getLegacyPlanFilePath, getPlanFilePath } from "@/common/utils/planStorage";
import { expandTilde } from "@/node/runtime/tildeExpansion";
import { ensurePlanSnapshot, getPlanReviewState } from "./planReviewService";
import { HistoryService } from "./historyService";

const PROJECT_PATH = "/tmp/project";

/** Config entries for plain workspaces `ids` under PROJECT_PATH (seed with saveWorkspaces). */
function workspaceEntries(
  ids: readonly string[],
  options: Omit<Partial<WorkspaceConfigEntry>, "id" | "path"> = {}
): WorkspaceConfigEntry[] {
  return ids.map((id) => projectWorkspace(PROJECT_PATH, id, id, options));
}

describe("WorkspaceService initialize", () => {
  let harness: WorkspaceServiceHarness;
  let workspaceService: WorkspaceService;
  let config: Config;

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness();
    ({ service: workspaceService, config } = harness);
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  test("contains pending-compaction recovery failures as per-task results", async () => {
    const h = await createAgentSessionHarness({ workspaceId: "task" });
    workspaceService.registerSession("task", h.session);
    spyOn(h.session, "dispatchPendingCompactionFollowUpIfNeeded").mockRejectedValueOnce(
      new Error("provider unavailable")
    );
    try {
      expect(await workspaceService.dispatchPendingCompactionFollowUp("task")).toEqual(
        Err("provider unavailable")
      );
    } finally {
      await workspaceService.disposeSession("task");
      await h.cleanup();
    }
  });

  test("schedules startup recovery for non-task, non-archived chats", async () => {
    await saveWorkspaces(config, PROJECT_PATH, [
      ...workspaceEntries(["live-ws", "archived-since-ws", "removed-since-ws"]),
      ...workspaceEntries(["task-ws"], { parentWorkspaceId: "live-ws", taskStatus: "running" }),
      ...workspaceEntries(["archived-ws"], { archivedAt: "2026-03-20T00:00:00.000Z" }),
    ]);
    // Active when metadata was read, but archived (or removed) by a client before the
    // scheduling loop ran: the live config decides, not the stale metadata.
    const readMetadata = config.getAllWorkspaceMetadata.bind(config);
    spyOn(config, "getAllWorkspaceMetadata").mockImplementationOnce(async (options) => {
      const staleSnapshot = await readMetadata(options);
      await config.editConfig((current) => {
        const project = current.projects.get(PROJECT_PATH)!;
        project.workspaces = project.workspaces.filter((ws) => ws.id !== "removed-since-ws");
        project.workspaces.find((ws) => ws.id === "archived-since-ws")!.archivedAt =
          "2026-03-21T00:00:00.000Z";
        return current;
      });
      return staleSnapshot;
    });

    const startupAccess = workspaceService as unknown as {
      startStartupRecovery: (workspaceId: string) => void;
    };
    const startStartupRecoverySpy = spyOn(startupAccess, "startStartupRecovery").mockImplementation(
      () => undefined
    );

    await workspaceService.initialize();

    expect(startStartupRecoverySpy).toHaveBeenCalledTimes(1);
    expect(startStartupRecoverySpy).toHaveBeenCalledWith(
      "live-ws",
      expect.objectContaining({ id: "live-ws" })
    );
  });

  test("swallows startup metadata lookup failures", async () => {
    await saveWorkspaces(config, PROJECT_PATH, workspaceEntries(["live-ws"]));
    spyOn(config, "getAllWorkspaceMetadata").mockRejectedValueOnce(new Error("config unavailable"));

    const startupAccess = workspaceService as unknown as {
      startStartupRecovery: (workspaceId: string) => void;
    };
    const startStartupRecoverySpy = spyOn(startupAccess, "startStartupRecovery");

    await workspaceService.initialize();

    expect(startStartupRecoverySpy).not.toHaveBeenCalled();
  });

  test("preserves scratch workdirs when config cannot be loaded", async () => {
    const scratchPath = path.join(config.rootDir, "scratch", "existing-scratch");
    await fsPromises.mkdir(scratchPath, { recursive: true });
    await fsPromises.writeFile(path.join(config.rootDir, "config.json"), "{invalid-json");

    await workspaceService.initialize();
    expect(await fsPromises.stat(scratchPath).then(() => true)).toBe(true);
  });

  test("removes stale orphaned scratch workdirs but keeps referenced and recent ones", async () => {
    const scratchDirFor = (id: string) => path.join(config.rootDir, "scratch", id);
    const referencedDir = scratchDirFor("referenced-scratch");
    const staleOrphanDir = scratchDirFor("stale-orphan-scratch");
    // A scratch chat created while the sweep runs has a fresh workdir and, briefly, no
    // config entry yet (createScratch persists config after mkdir).
    const freshOrphanDir = scratchDirFor("fresh-orphan-scratch");
    for (const dir of [referencedDir, staleOrphanDir, freshOrphanDir]) {
      await fsPromises.mkdir(dir, { recursive: true });
    }
    const staleTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    for (const dir of [referencedDir, staleOrphanDir]) {
      await fsPromises.utimes(dir, staleTime, staleTime);
    }
    await config.editConfig((cfg) => {
      cfg.projects.set(SCRATCH_PROJECT_CONFIG_KEY, {
        workspaces: [
          {
            kind: "scratch",
            path: referencedDir,
            id: "referenced-scratch",
            name: "scratch-referenced-scratch",
            runtimeConfig: { type: "local" },
          },
        ],
        projectKind: "system",
        trusted: true,
      });
      return cfg;
    });

    const startupAccess = workspaceService as unknown as {
      startStartupRecovery: (workspaceId: string) => void;
    };
    spyOn(startupAccess, "startStartupRecovery").mockImplementation(() => undefined);

    const exists = (dir: string) =>
      fsPromises.stat(dir).then(
        () => true,
        () => false
      );

    await workspaceService.initialize();
    expect(await exists(referencedDir)).toBe(true);
    expect(await exists(freshOrphanDir)).toBe(true);
    expect(await exists(staleOrphanDir)).toBe(false);
  });

  test("removes stale orphaned session directories but keeps referenced and recent ones", async () => {
    await config.editConfig((cfg) => {
      cfg.projects.set("/tmp/proj", {
        workspaces: [
          { path: "/tmp/proj/known-ws", id: "known-ws", name: "known-ws" },
          // Legacy entry without a stable ID: its session dir is keyed by "<project>-<workspace>".
          { path: "/tmp/proj/legacy-branch" },
        ],
      });
      return cfg;
    });

    const sessionDirFor = (id: string) => path.join(config.sessionsDir, id);
    const knownDir = sessionDirFor("known-ws");
    const legacyDir = sessionDirFor("proj-legacy-branch");
    // Unreferenced in config (the load-time migration removed the legacy Chat
    // with Xum entry) but exempt from reaping so downgrades keep the history.
    const muxChatDir = sessionDirFor("mux-chat");
    const staleOrphanDir = sessionDirFor("stale-orphan-ws");
    const freshOrphanDir = sessionDirFor("fresh-orphan-ws");
    for (const dir of [knownDir, legacyDir, muxChatDir, staleOrphanDir, freshOrphanDir]) {
      await fsPromises.mkdir(dir, { recursive: true });
    }
    // Backdate everything except the fresh orphan past the grace window, proving
    // retention comes from config references rather than directory age.
    const staleTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    for (const dir of [knownDir, legacyDir, muxChatDir, staleOrphanDir]) {
      await fsPromises.utimes(dir, staleTime, staleTime);
    }

    const startupAccess = workspaceService as unknown as {
      startStartupRecovery: (workspaceId: string) => void;
    };
    spyOn(startupAccess, "startStartupRecovery").mockImplementation(() => undefined);

    const exists = (dir: string) =>
      fsPromises.stat(dir).then(
        () => true,
        () => false
      );

    await workspaceService.initialize();
    expect(await exists(knownDir)).toBe(true);
    expect(await exists(legacyDir)).toBe(true);
    expect(await exists(muxChatDir)).toBe(true);
    expect(await exists(freshOrphanDir)).toBe(true);
    expect(await exists(staleOrphanDir)).toBe(false);
  });

  test("preserves orphaned session directories when config cannot be loaded", async () => {
    const orphanDir = path.join(config.sessionsDir, "stale-orphan-ws");
    await fsPromises.mkdir(orphanDir, { recursive: true });
    const staleTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fsPromises.utimes(orphanDir, staleTime, staleTime);
    await fsPromises.writeFile(path.join(config.rootDir, "config.json"), "{invalid-json");

    await workspaceService.initialize();
    expect(await fsPromises.stat(orphanDir).then(() => true)).toBe(true);
  });

  test("removes DevTools logs for archived workspaces at startup", async () => {
    await saveWorkspaces(config, PROJECT_PATH, [
      ...workspaceEntries(["live-ws"]),
      ...workspaceEntries(["archived-ws", "unarchived-since-ws", "archived-no-data-ws"], {
        archivedAt: "2026-03-20T00:00:00.000Z",
      }),
    ]);

    const removeWorkspaceData = mock(() => Promise.resolve());
    workspaceService.setDevToolsService({
      hasWorkspaceData: async (workspaceId: string) => {
        // Archived when metadata was read, but a client unarchived it (and produced new logs)
        // before the sweep reached it: the live config decides.
        if (workspaceId === "unarchived-since-ws") {
          await config.editConfig((current) => {
            current.projects
              .get(PROJECT_PATH)!
              .workspaces.find((ws) => ws.id === workspaceId)!.unarchivedAt =
              "2026-03-21T00:00:00.000Z";
            return current;
          });
        }
        return workspaceId !== "archived-no-data-ws";
      },
      removeWorkspaceData,
    });

    const startupAccess = workspaceService as unknown as {
      startStartupRecovery: (workspaceId: string) => void;
    };
    spyOn(startupAccess, "startStartupRecovery").mockImplementation(() => undefined);

    const metadataSpy = spyOn(config, "getAllWorkspaceMetadata");
    await workspaceService.initialize();
    expect(removeWorkspaceData).not.toHaveBeenCalled();
    expect(metadataSpy).toHaveBeenCalledWith({ probeCheckouts: false });

    await workspaceService.cleanupArchivedDevToolsLogs();

    expect(removeWorkspaceData).toHaveBeenCalledTimes(1);
    expect(removeWorkspaceData).toHaveBeenCalledWith("archived-ws");
  });

  test("bounds archived DevTools cleanup and stops admitting work on shutdown", async () => {
    await saveWorkspaces(
      config,
      PROJECT_PATH,
      workspaceEntries(
        Array.from({ length: 40 }, (_, i) => "archived-" + i),
        { archivedAt: "2026-01-01T00:00:00.000Z" }
      )
    );
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const abort = new AbortController();
    let active = 0;
    let peak = 0;
    const hasWorkspaceData = mock(async () => {
      active += 1;
      peak = Math.max(peak, active);
      if (active === 16) started.resolve();
      await release.promise;
      active -= 1;
      return false;
    });
    workspaceService.setDevToolsService({
      hasWorkspaceData,
      removeWorkspaceData: mock(() => Promise.resolve()),
    });
    const cleanup = workspaceService.cleanupArchivedDevToolsLogs({ signal: abort.signal });
    try {
      await started.promise;
      expect(peak).toBe(16);
      expect(hasWorkspaceData).toHaveBeenCalledTimes(16);
      abort.abort();
    } finally {
      release.resolve();
      await cleanup;
    }
    expect(hasWorkspaceData).toHaveBeenCalledTimes(16);
  });

  test("initialize schedules no recovery once shutdown has aborted it", async () => {
    await saveWorkspaces(config, PROJECT_PATH, workspaceEntries(["live-ws"]));
    const startupAccess = workspaceService as unknown as {
      startStartupRecovery: (workspaceId: string) => void;
    };
    const startStartupRecoverySpy = spyOn(startupAccess, "startStartupRecovery").mockImplementation(
      () => undefined
    );
    const shutdown = new AbortController();

    await workspaceService.initialize({ signal: shutdown.signal });
    expect(startStartupRecoverySpy).toHaveBeenCalledTimes(1);

    shutdown.abort();
    await workspaceService.initialize({ signal: shutdown.signal });
    expect(startStartupRecoverySpy).toHaveBeenCalledTimes(1);
  });

  test("beginShutdown disposes transient recovery sessions and halts the rest", async () => {
    const release = Promise.withResolvers<void>();
    const dispose = mock(() => release.promise);
    const beginShutdown = mock(() => undefined);
    const startupAccess = workspaceService as unknown as {
      transientStartupRecoverySessions: Map<string, AgentSession>;
      sessions: Map<string, AgentSession>;
      pendingWorkspaceCleanup: Set<Promise<void>>;
    };
    startupAccess.transientStartupRecoverySessions.set("ws-a", {
      dispose,
    } as unknown as AgentSession);
    startupAccess.transientStartupRecoverySessions.set("ws-b", {
      dispose,
    } as unknown as AgentSession);
    // A recovery session promoted with a retry pending, or a client-created session that
    // housekeeping scheduled recovery on: it may own a live stream, so it is not disposed.
    startupAccess.sessions.set("ws-promoted", {
      dispose,
      beginShutdown,
    } as unknown as AgentSession);

    workspaceService.beginShutdown();

    expect(dispose).toHaveBeenCalledTimes(2);
    expect(startupAccess.transientStartupRecoverySessions.size).toBe(2);
    release.resolve();
    await Promise.all(startupAccess.pendingWorkspaceCleanup);
    expect(startupAccess.transientStartupRecoverySessions.size).toBe(0);
    expect(beginShutdown).toHaveBeenCalledTimes(1);
    startupAccess.sessions.delete("ws-promoted");
  });

  test("bounds concurrent transient startup-recovery sessions while recovering every chat", async () => {
    const ids = Array.from({ length: 30 }, (_, index) => `ws-${index}`);
    await saveWorkspaces(config, PROJECT_PATH, workspaceEntries(ids));

    const startupAccess = workspaceService as unknown as {
      createSession: (workspaceId: string) => AgentSession;
      pendingWorkspaceCleanup: Set<Promise<void>>;
    };
    const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
    const gates: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
    let live = 0;
    let peakLive = 0;
    const createSessionSpy = spyOn(startupAccess, "createSession").mockImplementation(() => {
      live += 1;
      peakLive = Math.max(peakLive, live);
      const gate = Promise.withResolvers<void>();
      gates.push(gate);
      return {
        ...createCompactionAdmissionMocks(),
        runStartupRecovery: mock(() => gate.promise),
        shouldRetainAfterStartupRecovery: mock(() => false),
        scheduleStartupRecovery: mock(() => undefined),
        dispose: mock(() => {
          live -= 1;
        }),
      } as unknown as AgentSession;
    });

    await workspaceService.initialize();
    await flush();
    // Only a permit's worth of sessions exist while every recovery is still in flight.
    expect(createSessionSpy).toHaveBeenCalledTimes(STARTUP_RECOVERY_CONCURRENCY);

    // Finishing one recovery admits exactly one queued workspace.
    gates[0].resolve();
    await flush();
    expect(createSessionSpy).toHaveBeenCalledTimes(STARTUP_RECOVERY_CONCURRENCY + 1);

    for (let released = 1; released < ids.length; released++) {
      gates[released].resolve();
      await flush();
    }
    await Promise.all(startupAccess.pendingWorkspaceCleanup);
    expect(peakLive).toBe(STARTUP_RECOVERY_CONCURRENCY);
    expect(createSessionSpy.mock.calls.map(([workspaceId]) => workspaceId).sort()).toEqual(
      [...ids].sort()
    );
  });

  test("holds a startup-recovery slot until the transient session's disposal settles", async () => {
    const ids = Array.from({ length: STARTUP_RECOVERY_CONCURRENCY + 2 }, (_, i) => `ws-${i}`);
    // The first admitted session is promoted (recovery left activity alive); the rest are
    // transient and must be disposed before their slot is reusable.
    const promoted = ids[0];
    await saveWorkspaces(config, PROJECT_PATH, workspaceEntries(ids));

    const startupAccess = workspaceService as unknown as {
      createSession: (workspaceId: string) => AgentSession;
      pendingWorkspaceCleanup: Set<Promise<void>>;
      sessions: Map<string, AgentSession>;
    };
    const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
    const recoveries = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
    const disposals = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
    const createSessionSpy = spyOn(startupAccess, "createSession").mockImplementation(
      (workspaceId) => {
        const recovery = Promise.withResolvers<void>();
        recoveries.set(workspaceId, recovery);
        return {
          ...createCompactionAdmissionMocks(),
          runStartupRecovery: mock(() => recovery.promise),
          shouldRetainAfterStartupRecovery: mock(() => workspaceId === promoted),
          scheduleStartupRecovery: mock(() => undefined),
          onChatEvent: mock(() => () => undefined),
          onMetadataEvent: mock(() => () => undefined),
          dispose: mock(() => {
            const disposal = Promise.withResolvers<void>();
            disposals.set(workspaceId, disposal);
            return disposal.promise;
          }),
        } as unknown as AgentSession;
      }
    );
    const created = () => createSessionSpy.mock.calls.map(([workspaceId]) => workspaceId);

    await workspaceService.initialize();
    await flush();
    expect(created()).toHaveLength(STARTUP_RECOVERY_CONCURRENCY);
    const [, transient] = created();

    // A transient session whose recovery finished but whose dispose is still pending keeps
    // its slot: listeners and heap are only released when dispose settles.
    recoveries.get(transient)!.resolve();
    await flush();
    expect(disposals.has(transient)).toBe(true);
    expect(created()).toHaveLength(STARTUP_RECOVERY_CONCURRENCY);

    disposals.get(transient)!.resolve();
    await flush();
    expect(created()).toHaveLength(STARTUP_RECOVERY_CONCURRENCY + 1);

    // A promoted session is live by design and releases its slot as soon as recovery ends.
    recoveries.get(promoted)!.resolve();
    await flush();
    expect(startupAccess.sessions.get(promoted)).toBeDefined();
    expect(disposals.has(promoted)).toBe(false);
    expect(created()).toHaveLength(STARTUP_RECOVERY_CONCURRENCY + 2);

    // Drain in rounds: each disposal admits another session whose gates appear late.
    for (const _round of ids) {
      for (const recovery of recoveries.values()) recovery.resolve();
      await flush();
      for (const disposal of disposals.values()) disposal.resolve();
      await flush();
    }
    await Promise.all(startupAccess.pendingWorkspaceCleanup);
    expect(created().sort()).toEqual([...ids].sort());
    startupAccess.sessions.delete(promoted);
  });

  test("skips queued startup recoveries whose workspace was archived or removed while waiting", async () => {
    const ids = Array.from({ length: STARTUP_RECOVERY_CONCURRENCY + 4 }, (_, i) => `ws-${i}`);
    const archivedWhileQueued = ids[STARTUP_RECOVERY_CONCURRENCY + 1];
    const removedWhileQueued = ids[STARTUP_RECOVERY_CONCURRENCY + 2];
    await saveWorkspaces(config, PROJECT_PATH, workspaceEntries(ids));

    const startupAccess = workspaceService as unknown as {
      createSession: (workspaceId: string) => AgentSession;
      pendingWorkspaceCleanup: Set<Promise<void>>;
    };
    const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
    const gates: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
    const recoveredWith = new Map<string, WorkspaceMetadata | undefined>();
    const createSessionSpy = spyOn(startupAccess, "createSession").mockImplementation(
      (workspaceId) => {
        const gate = Promise.withResolvers<void>();
        gates.push(gate);
        return {
          ...createCompactionAdmissionMocks(),
          runStartupRecovery: mock((metadata?: WorkspaceMetadata) => {
            recoveredWith.set(workspaceId, metadata);
            return gate.promise;
          }),
          shouldRetainAfterStartupRecovery: mock(() => false),
          scheduleStartupRecovery: mock(() => undefined),
          dispose: mock(() => undefined),
        } as unknown as AgentSession;
      }
    );

    await workspaceService.initialize();
    await flush();
    expect(createSessionSpy).toHaveBeenCalledTimes(STARTUP_RECOVERY_CONCURRENCY);

    // While the tail is still waiting on a permit, the user archives one workspace, removes
    // another, and retitles a third.
    const retitled = ids[STARTUP_RECOVERY_CONCURRENCY + 3];
    await config.editConfig((current) => {
      const project = current.projects.get(PROJECT_PATH)!;
      project.workspaces = project.workspaces.filter((ws) => ws.id !== removedWhileQueued);
      project.workspaces.find((ws) => ws.id === archivedWhileQueued)!.archivedAt =
        "2026-03-20T00:00:00.000Z";
      project.workspaces.find((ws) => ws.id === retitled)!.title = "Renamed while queued";
      return current;
    });

    // Array iteration is live: gates pushed by newly admitted sessions are released too.
    for (const gate of gates) {
      gate.resolve();
      await flush();
    }
    await Promise.all(startupAccess.pendingWorkspaceCleanup);

    const recovered = createSessionSpy.mock.calls.map(([workspaceId]) => workspaceId).sort();
    expect(recovered).toEqual(
      ids.filter((id) => id !== archivedWhileQueued && id !== removedWhileQueued).sort()
    );
    // Recovery sees the registry as it is after the wait, not the scheduling-time snapshot.
    expect(recoveredWith.get(retitled)?.title).toBe("Renamed while queued");
  });

  test("disposes transient startup-recovery sessions that go idle", async () => {
    const dispose = mock(() => undefined);
    const fakeSession = {
      ...createCompactionAdmissionMocks(),
      runStartupRecovery: mock(() => Promise.resolve()),
      shouldRetainAfterStartupRecovery: mock(() => false),
      scheduleStartupRecovery: mock(() => undefined),
      dispose,
    } as unknown as AgentSession;

    const startupAccess = workspaceService as unknown as {
      startStartupRecovery: (workspaceId: string) => void;
      createSession: (workspaceId: string) => AgentSession;
      sessions: Map<string, AgentSession>;
      pendingWorkspaceCleanup: Set<Promise<void>>;
    };
    const createSessionSpy = spyOn(startupAccess, "createSession").mockImplementation(
      () => fakeSession
    );
    await saveWorkspaces(config, PROJECT_PATH, workspaceEntries(["live-ws"]));

    startupAccess.startStartupRecovery("live-ws");
    // Recovery re-reads the real registry from disk before it runs; wait for the tracked task.
    await Promise.all(startupAccess.pendingWorkspaceCleanup);

    expect(createSessionSpy).toHaveBeenCalledWith("live-ws");
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(startupAccess.sessions.has("live-ws")).toBe(false);
  });

  test("retains transient startup-recovery sessions when recovery stays active", async () => {
    const dispose = mock(() => undefined);
    const onChatEvent = mock(() => () => undefined);
    const onMetadataEvent = mock(() => () => undefined);
    const fakeSession = {
      ...createCompactionAdmissionMocks(),
      runStartupRecovery: mock(() => Promise.resolve()),
      shouldRetainAfterStartupRecovery: mock(() => true),
      scheduleStartupRecovery: mock(() => undefined),
      onChatEvent,
      onMetadataEvent,
      dispose,
    } as unknown as AgentSession;

    const startupAccess = workspaceService as unknown as {
      startStartupRecovery: (workspaceId: string) => void;
      createSession: (workspaceId: string) => AgentSession;
      sessions: Map<string, AgentSession>;
      pendingWorkspaceCleanup: Set<Promise<void>>;
    };
    spyOn(startupAccess, "createSession").mockImplementation(() => fakeSession);
    await saveWorkspaces(config, PROJECT_PATH, workspaceEntries(["live-ws"]));

    startupAccess.startStartupRecovery("live-ws");
    // Recovery re-reads the real registry from disk before it runs; wait for the tracked task.
    await Promise.all(startupAccess.pendingWorkspaceCleanup);

    expect(dispose).not.toHaveBeenCalled();
    expect(startupAccess.sessions.get("live-ws")).toBe(fakeSession);
  });

  test("claims transient startup-recovery sessions instead of creating duplicates", () => {
    const onChatEvent = mock(() => () => undefined);
    const onMetadataEvent = mock(() => () => undefined);
    const fakeSession = {
      ...createCompactionAdmissionMocks(),
      onChatEvent,
      onMetadataEvent,
    } as unknown as AgentSession;

    const startupAccess = workspaceService as unknown as {
      transientStartupRecoverySessions: Map<string, AgentSession>;
      sessions: Map<string, AgentSession>;
      getOrCreateSession: (workspaceId: string) => AgentSession;
      createSession: (workspaceId: string) => AgentSession;
    };
    startupAccess.transientStartupRecoverySessions.set("live-ws", fakeSession);
    const createSessionSpy = spyOn(startupAccess, "createSession");

    const claimedSession = startupAccess.getOrCreateSession("live-ws");

    expect(claimedSession).toBe(fakeSession);
    expect(startupAccess.transientStartupRecoverySessions.has("live-ws")).toBe(false);
    expect(startupAccess.sessions.get("live-ws")).toBe(fakeSession);
    expect(createSessionSpy).not.toHaveBeenCalled();
  });
});

describe("WorkspaceService transient startup probes", () => {
  async function setupProbe() {
    const h = await createAgentSessionHarness({ workspaceId: "legacy-child" });
    const allListeners = () =>
      h.aiEmitter.eventNames().reduce((total, name) => total + h.aiEmitter.listenerCount(name), 0);
    const sessionListeners = allListeners();
    await h.historyService.appendToHistory(
      "legacy-child",
      createMuxMessage("done", "assistant", "Finished", { finishReason: "stop" })
    );
    const service = createWorkspaceServiceForTest({
      config: h.config,
      historyService: h.historyService,
      aiService: h.aiService as unknown as AIService,
    });
    const access = service as unknown as {
      createSession: (id: string) => AgentSession;
      sessions: Map<string, AgentSession>;
      transientStartupRecoverySessions: Map<string, AgentSession>;
      pendingWorkspaceCleanup: Set<Promise<void>>;
    };
    const create = spyOn(access, "createSession").mockReturnValueOnce(h.session);
    const serviceListeners = allListeners() - sessionListeners;
    const listenerCount = () => allListeners() - serviceListeners;
    const cleanup = async () => {
      await Promise.all(access.pendingWorkspaceCleanup);
      await service.disposeSession("legacy-child");
      await h.session.dispose();
      await h.cleanup();
    };
    return { h, service, access, create, listenerCount, sessionListeners, cleanup };
  }

  test("idle legacy probes and empty compaction checks release their real listeners", async () => {
    const p = await setupProbe();
    try {
      expect(p.listenerCount()).toBeGreaterThan(0);
      expect(p.service.clearQueue("legacy-child")).toEqual(Ok(undefined));
      expect(p.create).not.toHaveBeenCalled();
      expect(await p.service.getStartupRecoveryState("legacy-child")).toBe("idle");
      await Promise.all(p.access.pendingWorkspaceCleanup);
      expect(p.listenerCount()).toBe(0);
      expect(await p.service.dispatchPendingCompactionFollowUp("legacy-child")).toEqual(Ok(false));
      await Promise.all(p.access.pendingWorkspaceCleanup);
      expect(p.create).toHaveBeenCalledTimes(2);
      expect(p.access.sessions.size).toBe(0);
      expect(p.access.transientStartupRecoverySessions.size).toBe(0);
      expect(p.listenerCount()).toBe(0);
    } finally {
      await p.cleanup();
    }
  });

  test.each(["registered", "transient"] as const)(
    "probes preserve existing %s sessions",
    async (kind) => {
      const p = await setupProbe();
      try {
        if (kind === "registered") p.service.registerSession("legacy-child", p.h.session);
        else p.access.transientStartupRecoverySessions.set("legacy-child", p.h.session);
        expect(await p.service.getStartupRecoveryState("legacy-child")).toBe("idle");
        expect(p.create).not.toHaveBeenCalled();
        expect(p.h.session.closingSignal.aborted).toBe(false);
        expect(p.listenerCount()).toBeGreaterThan(0);
        expect(p.access.pendingWorkspaceCleanup.size).toBe(0);
      } finally {
        await p.cleanup();
      }
    }
  );

  test("a client can adopt an in-flight probe without its session being disposed", async () => {
    const p = await setupProbe();
    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const read = p.h.historyService.getLastMessages.bind(p.h.historyService);
    spyOn(p.h.historyService, "getLastMessages").mockImplementationOnce(async (...args) => {
      reading.resolve();
      await release.promise;
      return read(...args);
    });
    try {
      const probe = p.service.getStartupRecoveryState("legacy-child");
      await reading.promise;
      expect(p.service.getOrCreateSession("legacy-child")).toBe(p.h.session);
      release.resolve();
      expect(await probe).toBe("idle");
      expect(p.access.sessions.get("legacy-child")).toBe(p.h.session);
      expect(p.h.session.closingSignal.aborted).toBe(false);
      expect(p.access.pendingWorkspaceCleanup.size).toBe(0);
    } finally {
      release.resolve();
      await p.cleanup();
    }
  });

  test("a timed-out physical read is disposed off-startup without deleting its replacement", async () => {
    const p = await setupProbe();
    const release = Promise.withResolvers<void>();
    const read = p.h.historyService.getLastMessages.bind(p.h.historyService);
    spyOn(p.h.historyService, "getLastMessages").mockImplementationOnce(async (...args) => {
      await release.promise;
      return read(...args);
    });
    const probeState = p.h.session.getStartupRecoveryState.bind(p.h.session);
    spyOn(p.h.session, "getStartupRecoveryState").mockImplementation(() => probeState(10));
    try {
      // The read is still held open after the admission deadline. Cleanup must own its lease,
      // not block this answer or release resources while the physical read is still using them.
      expect(await p.service.getStartupRecoveryState("legacy-child")).toBe("blocked");
      expect(p.access.transientStartupRecoverySessions.size).toBe(0);
      expect(p.access.pendingWorkspaceCleanup.size).toBe(1);
      expect(p.h.session.closingSignal.aborted).toBe(true);
      expect(p.listenerCount()).toBeGreaterThan(0);
      const replacement = p.service.getOrCreateSession("legacy-child");
      expect(replacement).not.toBe(p.h.session);
      release.resolve();
      await Promise.all(p.access.pendingWorkspaceCleanup);
      expect(p.access.sessions.get("legacy-child")).toBe(replacement);
      expect(replacement.closingSignal.aborted).toBe(false);
      expect(p.listenerCount()).toBe(p.sessionListeners);
    } finally {
      release.resolve();
      await p.cleanup();
    }
  });

  test("a failed probe still disposes its unadopted session", async () => {
    const p = await setupProbe();
    spyOn(p.h.session, "getStartupRecoveryState").mockRejectedValueOnce(new Error("Probe failed"));
    try {
      const result = await p.service
        .getStartupRecoveryState("legacy-child")
        .catch((error: unknown) => error);
      expect(result).toMatchObject({ message: "Probe failed" });
      await Promise.all(p.access.pendingWorkspaceCleanup);
      expect(p.access.transientStartupRecoverySessions.size).toBe(0);
      expect(p.listenerCount()).toBe(0);
    } finally {
      await p.cleanup();
    }
  });
});

describe("WorkspaceService registration-time plugin override sanitization", () => {
  // A LocalRuntime checkout preserves .mux/mcp.local.jsonc across workspace
  // removal, and a removed workspace is invisible to the Agent Plugin
  // uninstaller's pruning/tombstones. Consent dies with the workspace:
  // registering the directory as a NEW workspace sanitizes canonical plugin
  // keys — unless a live sibling still resolves to the same path (its consent
  // context is alive), and a failed sanitize aborts creation instead of
  // silently activating stale enables.
  interface SanitizeAccess {
    sanitizeStalePluginOverridesForNewWorkspace(
      workspaceId: string,
      workspacePath: string,
      persistentSiblingConfig?: Pick<Config, "loadConfigOrDefault">
    ): Promise<string | undefined>;
    pendingPluginSanitizations: Set<string>;
    rollbackUnsanitizedWorkspaceRegistration(workspaceId: string): Promise<boolean>;
  }

  let harness: WorkspaceServiceHarness;
  const extraRoots: string[] = [];

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
    for (const root of extraRoots.splice(0)) {
      await fsPromises.rm(root, { recursive: true, force: true });
    }
  });

  async function makeService(
    existingWorkspaces: Array<Pick<WorkspaceConfigEntry, "id" | "path" | "runtimeConfig">>
  ): Promise<WorkspaceService> {
    await saveWorkspaces(
      harness.config,
      "/tmp/proj",
      existingWorkspaces.map((ws) => ({ ...ws, name: ws.id }))
    );
    return harness.service;
  }

  /** A second real Config standing in for the persistent ~/.xum config of a CLI run. */
  async function makePersistentConfig(configJson?: string): Promise<Config> {
    const root = await fsPromises.mkdtemp(path.join(tmpdir(), "xum-persistent-config-"));
    extraRoots.push(root);
    if (configJson !== undefined) {
      await fsPromises.writeFile(path.join(root, "config.json"), configJson);
    }
    return new Config(root);
  }

  test("sanitizes canonical plugin keys when no sibling shares the path", async () => {
    const service = await makeService([{ id: "ws-new", path: "/tmp/proj" }]);
    const pruned: string[] = [];
    service.setWorkspaceMcpOverridesService({
      acquireWorkspaceLock: () => Promise.resolve(() => Promise.resolve()),
      prunePluginOverrideKeys: (workspaceId, keyPrefix) => {
        pruned.push(`${workspaceId}:${keyPrefix}`);
        return Promise.resolve();
      },
      copyOverridesToForkedCheckout: () => Promise.resolve(),
    });
    const error = await (
      service as unknown as SanitizeAccess
    ).sanitizeStalePluginOverridesForNewWorkspace("ws-new", "/tmp/proj");
    expect(error).toBeUndefined();
    expect(pruned).toEqual(["ws-new:plugin:"]);
  });

  test("skips sanitization when the live sibling is only visible in the persistent config", async () => {
    // xum run / xum workflow register on an EPHEMERAL temp config whose
    // project entries carry no workspace records; a desktop workspace live on
    // the same checkout exists only in the persistent config. Pruning would
    // strip enables that live consent context still owns from the shared
    // .xum/mcp.local.jsonc — the persistent sibling must force a skip, while
    // a persistent record for a DIFFERENT checkout must not.
    const service = await makeService([{ id: "ws-new", path: "/tmp/proj" }]);
    const pruned: string[] = [];
    service.setWorkspaceMcpOverridesService({
      acquireWorkspaceLock: () => Promise.resolve(() => Promise.resolve()),
      prunePluginOverrideKeys: (workspaceId, keyPrefix) => {
        pruned.push(`${workspaceId}:${keyPrefix}`);
        return Promise.resolve();
      },
      copyOverridesToForkedCheckout: () => Promise.resolve(),
    });
    const persistentWith = async (workspacePath: string): Promise<Config> => {
      const persistent = await makePersistentConfig();
      await saveWorkspaces(persistent, "/tmp/proj", [
        { id: "ws-desktop", name: "ws-desktop", path: workspacePath },
      ]);
      return persistent;
    };

    const skip = await (
      service as unknown as SanitizeAccess
    ).sanitizeStalePluginOverridesForNewWorkspace(
      "ws-new",
      "/tmp/proj",
      await persistentWith("/tmp/proj")
    );
    expect(skip).toBeUndefined();
    expect(pruned).toEqual([]);

    const prune = await (
      service as unknown as SanitizeAccess
    ).sanitizeStalePluginOverridesForNewWorkspace(
      "ws-new",
      "/tmp/proj",
      await persistentWith("/tmp/other")
    );
    expect(prune).toBeUndefined();
    expect(pruned).toEqual(["ws-new:plugin:"]);
  });

  test("refuses to prune when the persistent sibling config is unreadable", async () => {
    // The lenient loadConfigOrDefault swallows a malformed ~/.xum/config.json
    // into an EMPTY project map — which reads as "no live sibling" and would
    // prune enables a live desktop workspace still owns. The persistent
    // source must be read in throwing mode and sanitization must fail closed
    // (abort the registration, leave the override file untouched).
    const service = await makeService([{ id: "ws-new", path: "/tmp/proj" }]);
    const pruned: string[] = [];
    service.setWorkspaceMcpOverridesService({
      acquireWorkspaceLock: () => Promise.resolve(() => Promise.resolve()),
      prunePluginOverrideKeys: (workspaceId, keyPrefix) => {
        pruned.push(`${workspaceId}:${keyPrefix}`);
        return Promise.resolve();
      },
      copyOverridesToForkedCheckout: () => Promise.resolve(),
    });
    // A lenient read would hide the corruption behind an empty map.
    const broken = await makePersistentConfig("{malformed-json");
    const error = await (
      service as unknown as SanitizeAccess
    ).sanitizeStalePluginOverridesForNewWorkspace("ws-new", "/tmp/proj", broken);
    expect(error).toContain("unreadable");
    expect(pruned).toEqual([]);
  });

  test("skips sanitization while a live sibling resolves to the same path", async () => {
    // Conversation forks of a local workspace share the checkout: the
    // sibling's consent context is alive, so its enables must survive.
    const service = await makeService([
      { id: "ws-sibling", path: "/tmp/proj" },
      { id: "ws-new", path: "/tmp/proj/" },
    ]);
    const pruned: string[] = [];
    service.setWorkspaceMcpOverridesService({
      acquireWorkspaceLock: () => Promise.resolve(() => Promise.resolve()),
      prunePluginOverrideKeys: (workspaceId, keyPrefix) => {
        pruned.push(`${workspaceId}:${keyPrefix}`);
        return Promise.resolve();
      },
      copyOverridesToForkedCheckout: () => Promise.resolve(),
    });
    const error = await (
      service as unknown as SanitizeAccess
    ).sanitizeStalePluginOverridesForNewWorkspace("ws-new", "/tmp/proj");
    expect(error).toBeUndefined();
    expect(pruned).toEqual([]);
  });

  test("a failed sanitize surfaces an error so creation aborts", async () => {
    const service = await makeService([{ id: "ws-new", path: "/tmp/proj" }]);
    service.setWorkspaceMcpOverridesService({
      acquireWorkspaceLock: () => Promise.resolve(() => Promise.resolve()),
      prunePluginOverrideKeys: () =>
        Promise.reject(new Error('duplicate "enabledServers" properties')),
      copyOverridesToForkedCheckout: () => Promise.resolve(),
    });
    const error = await (
      service as unknown as SanitizeAccess
    ).sanitizeStalePluginOverridesForNewWorkspace("ws-new", "/tmp/proj");
    expect(error).toContain("could not be sanitized");
    expect(error).toContain("mcp.local.jsonc");
  });

  test("an off-host workspace with an equal path string is not a sibling", async () => {
    // SSH/container paths occupy a different filesystem namespace: an equal
    // STRING proves nothing about the local overrides file, and skipping
    // would leave a stale enable to activate on the next local request.
    const service = await makeService([
      {
        id: "ws-ssh",
        path: "/tmp/proj",
        runtimeConfig: { type: "ssh", host: "box", srcBaseDir: "/home/box/src" },
      },
      { id: "ws-new", path: "/tmp/proj" },
    ]);
    const pruned: string[] = [];
    service.setWorkspaceMcpOverridesService({
      acquireWorkspaceLock: () => Promise.resolve(() => Promise.resolve()),
      prunePluginOverrideKeys: (workspaceId, keyPrefix) => {
        pruned.push(`${workspaceId}:${keyPrefix}`);
        return Promise.resolve();
      },
      copyOverridesToForkedCheckout: () => Promise.resolve(),
    });
    const error = await (
      service as unknown as SanitizeAccess
    ).sanitizeStalePluginOverridesForNewWorkspace("ws-new", "/tmp/proj");
    expect(error).toBeUndefined();
    expect(pruned).toEqual(["ws-new:plugin:"]);
  });

  test("a sibling registered through a symlinked spelling still forces a skip", async () => {
    // Canonical (realpath) identity, not just spelling: pruning here would
    // strip the live symlink-spelled sibling's enables from the shared file.
    const realDir = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-sanitize-real-"));
    const linkPath = `${realDir}-link`;
    await fsPromises.symlink(realDir, linkPath);
    try {
      const service = await makeService([
        { id: "ws-symlink-sibling", path: linkPath },
        { id: "ws-new", path: realDir },
      ]);
      const pruned: string[] = [];
      service.setWorkspaceMcpOverridesService({
        acquireWorkspaceLock: () => Promise.resolve(() => Promise.resolve()),
        prunePluginOverrideKeys: (workspaceId, keyPrefix) => {
          pruned.push(`${workspaceId}:${keyPrefix}`);
          return Promise.resolve();
        },
        copyOverridesToForkedCheckout: () => Promise.resolve(),
      });
      const error = await (
        service as unknown as SanitizeAccess
      ).sanitizeStalePluginOverridesForNewWorkspace("ws-new", realDir);
      expect(error).toBeUndefined();
      expect(pruned).toEqual([]);
    } finally {
      await fsPromises.rm(linkPath, { force: true });
      await fsPromises.rm(realDir, { recursive: true, force: true });
    }
  });

  test("an overlapping registration pending its own sanitization is not a sibling", async () => {
    // Two creations for the same checkout can both persist config entries
    // before either sanitizes; a not-yet-sanitized entry is no proof of live
    // consent, so the scan must ignore it or BOTH creations skip pruning.
    const service = await makeService([
      { id: "ws-concurrent", path: "/tmp/proj" },
      { id: "ws-new", path: "/tmp/proj" },
    ]);
    (service as unknown as SanitizeAccess).pendingPluginSanitizations.add("ws-concurrent");
    const pruned: string[] = [];
    service.setWorkspaceMcpOverridesService({
      acquireWorkspaceLock: () => Promise.resolve(() => Promise.resolve()),
      prunePluginOverrideKeys: (workspaceId, keyPrefix) => {
        pruned.push(`${workspaceId}:${keyPrefix}`);
        return Promise.resolve();
      },
      copyOverridesToForkedCheckout: () => Promise.resolve(),
    });
    const error = await (
      service as unknown as SanitizeAccess
    ).sanitizeStalePluginOverridesForNewWorkspace("ws-new", "/tmp/proj");
    expect(error).toBeUndefined();
    expect(pruned).toEqual(["ws-new:plugin:"]);
  });

  test("rollback verification detects a swallowed config write failure", async () => {
    // Config.saveConfig logs and swallows write errors, so removeWorkspace
    // can resolve while the entry survives on disk; the rollback must verify
    // absence rather than trust the resolved promise.
    const service = await makeService([{ id: "ws-stuck", path: "/tmp/proj" }]);
    const removeSpy = spyOn(harness.config, "removeWorkspace").mockResolvedValue(undefined);
    const access = service as unknown as SanitizeAccess;
    expect(await access.rollbackUnsanitizedWorkspaceRegistration("ws-stuck")).toBe(false);
    removeSpy.mockRestore();
    // A rollback that actually lands verifies clean.
    expect(await access.rollbackUnsanitizedWorkspaceRegistration("ws-gone")).toBe(true);
  });
});

describe("WorkspaceService disposal ownership", () => {
  test.each([false, true])(
    "leased cleanup removes real session files without a task-tree self-join (external=%s)",
    async (externalRemoval) => {
      const h = await createAgentSessionHarness({ workspaceId: "leased-removal" });
      const workspaceId = "leased-removal";
      const service = createWorkspaceServiceForTest({
        config: h.config,
        historyService: h.historyService,
        extensionMetadata: new ExtensionMetadataService(
          path.join(h.config.rootDir, "extensionMetadata.json")
        ),
        aiService: createMockAIService({
          getWorkspaceMetadata: mock(() => Promise.resolve(Err("not found"))),
        }),
      });
      const tree = new MutexMap<string>();
      service.setAgentTaskIntegration(
        makeAgentTaskIntegrationFake({
          withTaskTreeLifecycleLock: (_id, run) => tree.withLock("tree", run),
        })
      );
      service.registerSession(workspaceId, h.session);
      await h.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("user", "user", "remove after callback")
      );
      const sessionDir = path.join(h.config.sessionsDir, workspaceId);
      const { coordinator } = h.session as unknown as { coordinator: TurnCoordinator };
      const lease = coordinator.enterExecution();
      const disposalEntered = Promise.withResolvers<void>();
      const originalDispose = h.session.dispose.bind(h.session);
      spyOn(h.session, "dispose").mockImplementation(() => {
        disposalEntered.resolve();
        return originalDispose();
      });
      const removed = Promise.withResolvers<Result<void>>();
      let external: Promise<Result<void>> | undefined;
      try {
        if (externalRemoval) {
          external = service.remove(workspaceId, true);
          await disposalEntered.promise;
          expect(existsSync(sessionDir)).toBe(true);
        }
        // This is the leased continuation callback's tail: schedule removal without
        // awaiting it, then return/release. The service owns the actual remove and join.
        service.deferWorkspaceCleanup(async () => {
          removed.resolve(await service.remove(workspaceId, true));
        });
        lease[Symbol.dispose]();
        if (external) expect((await external).success).toBe(true);
        expect((await removed.promise).success).toBe(true);
        expect(existsSync(sessionDir)).toBe(false);
      } finally {
        lease[Symbol.dispose]();
        await external;
        await h.session.dispose();
        await h.cleanup();
      }
    }
  );

  test.each(["workspace-busy", "queue-busy", "queue-only"] as const)(
    "shutdown cancels %s wait without pretending the physical lease drained",
    async (kind) => {
      const h = await createAgentSessionHarness({ workspaceId: "closing-idle-wait" });
      const service = createWorkspaceServiceForTest({
        config: h.config,
        historyService: h.historyService,
      });
      service.registerSession("closing-idle-wait", h.session);
      const { coordinator } = h.session as unknown as { coordinator: TurnCoordinator };
      const lease = coordinator.enterExecution();
      if (kind === "queue-only") h.session.queueMessage("pending");
      else {
        const admitted = coordinator.prepare({
          kind: "fresh",
          intent: "handoff",
          expectedTurnId: coordinator.turnId,
        });
        expect(admitted.status).toBe("admitted");
      }
      const waiting = (
        kind === "workspace-busy"
          ? service.waitForWorkspaceIdle("closing-idle-wait")
          : service.waitForIdleAndNoQueuedMessages("closing-idle-wait")
      ).then(
        () => undefined,
        (error: unknown) => error
      );
      h.session.beginShutdown();
      let drained = false;
      const drain = coordinator.drain().then(() => {
        drained = true;
      });
      try {
        expect(await waiting).toBeInstanceOf(Error);
        expect(drained).toBe(false);
        if (kind !== "queue-only") expect(coordinator.phase).toBe("preparing");
      } finally {
        lease[Symbol.dispose]();
        await drain;
        await service.disposeSession("closing-idle-wait");
        await h.cleanup();
      }
    }
  );

  test("an old disposal cannot remove replacement session subscriptions", async () => {
    const h = await createAgentSessionHarness({ workspaceId: "dispose-replacement" });
    const replacement = await createAgentSessionHarness({ workspaceId: "dispose-replacement" });
    const service = createWorkspaceServiceForTest({
      config: h.config,
      historyService: h.historyService,
    });
    service.registerSession("dispose-replacement", h.session);
    const internals = service as unknown as {
      sessions: Map<string, AgentSession>;
      sessionSubscriptions: Map<string, { chat: () => void; metadata: () => void }>;
    };
    const { coordinator } = h.session as unknown as { coordinator: TurnCoordinator };
    const lease = coordinator.enterExecution();
    const disposal = service.disposeSession("dispose-replacement");
    try {
      internals.sessions.delete("dispose-replacement");
      service.registerSession("dispose-replacement", replacement.session);
      const subscriptions = internals.sessionSubscriptions.get("dispose-replacement");
      lease[Symbol.dispose]();
      await disposal;
      expect(internals.sessions.get("dispose-replacement")).toBe(replacement.session);
      expect(internals.sessionSubscriptions.get("dispose-replacement")).toBe(subscriptions);
    } finally {
      lease[Symbol.dispose]();
      await disposal;
      await service.disposeSession("dispose-replacement");
      await h.cleanup();
      await replacement.cleanup();
    }
  });
});

/**
 * #4420: a full clear commits its history change and deletes the plan file afterwards. Another
 * backend on the same workspace (XUM_ALLOW_MULTIPLE_INSTANCES=1, or the desktop app beside
 * `xum server`) shares the session directory and the cross-process history lock but none of the
 * clearing backend's in-memory fencing. It is modelled as a second HistoryService over the same
 * config that runs an on-demand snapshot capture.
 */
describe("WorkspaceService full clear vs another backend's plan snapshot capture", () => {
  const projectName = `plan-clear-window-${process.pid}-${Date.now()}`;
  const planDir = expandTilde(path.dirname(getPlanFilePath("x", projectName)));
  const legacyDir = expandTilde(path.dirname(getLegacyPlanFilePath("x", "~/.xum")));
  const legacyPlans: string[] = [];

  afterEach(async () => {
    await fsPromises.rm(planDir, { recursive: true, force: true });
    for (const file of legacyPlans.splice(0)) await fsPromises.rm(file, { force: true });
  });

  async function setup(workspaceId: string, location: "canonical" | "legacy" = "canonical") {
    const harness = await createWorkspaceServiceHarness({
      aiServiceOverrides: { stopStream: mock(() => Promise.resolve(Ok(undefined))) },
    });
    const { config, historyService, service: clearer } = harness;
    // WorkspaceService derives the project name (and so the plan directory) from this path.
    const projectPath = path.join(config.rootDir, projectName);
    const metadata = {
      id: workspaceId,
      name: workspaceId,
      projectName,
      projectPath,
      runtimeConfig: { type: "local" as const },
    };
    await config.addWorkspace(projectPath, metadata);
    const other = new HistoryService(config);
    const seeded = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "please plan", {})
    );
    expect(seeded.success).toBe(true);
    const planPath =
      location === "canonical"
        ? expandTilde(getPlanFilePath(workspaceId, projectName))
        : expandTilde(getLegacyPlanFilePath(workspaceId, "~/.xum"));
    if (location === "legacy") legacyPlans.push(planPath);
    await fsPromises.mkdir(path.dirname(planPath), { recursive: true });
    await fsPromises.writeFile(planPath, "# Plan\n\nBefore the clear.\n");
    const internals = clearer as unknown as {
      deletePlanFilesForWorkspace: (id: string, meta: FrontendWorkspaceMetadata) => Promise<void>;
      clearHistoryThroughCompactionCancellation: (
        id: string,
        percentage: number,
        onCancellationFailure: (error: string) => void
      ) => Promise<Result<number[]>>;
    };
    /** Plan files moved aside for this workspace and not restored or removed. */
    const asideFiles = async () => {
      const names = [
        ...(await fsPromises.readdir(planDir).catch(() => [])),
        ...(await fsPromises.readdir(legacyDir).catch(() => [])),
      ];
      return names.filter((name) => name.startsWith(`${workspaceId}.md.`));
    };
    const snapshotCount = async () => {
      const state = await getPlanReviewState(other, workspaceId);
      expect(state.success).toBe(true);
      return state.success ? state.data.snapshots.length : -1;
    };
    const capture = () =>
      ensurePlanSnapshot(
        { historyService: other, emitChatEvent: () => undefined },
        {
          workspaceId,
          metadata,
        }
      );
    const teardown = async () => {
      await clearer.disposeSession(workspaceId);
      await harness.cleanup();
    };
    return {
      clearer,
      internals,
      planPath,
      asideFiles,
      snapshotCount,
      capture,
      teardown,
      other: () => other,
    };
  }

  for (const location of ["canonical", "legacy"] as const) {
    test(`a capture between the history commit and the plan deletion does not append (${location} plan path)`, async () => {
      const t = await setup(`plan-clear-window-${location}`, location);
      try {
        const original = t.internals.deletePlanFilesForWorkspace.bind(t.clearer);
        let captured: Awaited<ReturnType<typeof t.capture>> | undefined;
        spyOn(t.internals, "deletePlanFilesForWorkspace").mockImplementation(async (id, meta) => {
          // The history is already cleared and the generation already advanced, so the capture's
          // frontier matches at its append; only the plan read can refuse it.
          captured = await t.capture();
          return original(id, meta);
        });
        const cleared = await t.clearer.truncateHistory(`plan-clear-window-${location}`, 1.0);
        expect(cleared.success).toBe(true);
        expect(captured).toBeDefined();
        expect(captured?.success === false && captured.error.type).toBe("plan_missing");
        expect(await t.snapshotCount()).toBe(0);
        expect(existsSync(t.planPath)).toBe(false);
        expect(await t.asideFiles()).toEqual([]);
      } finally {
        await t.teardown();
      }
    });
  }

  test("a failed clear keeps the plan file", async () => {
    const t = await setup("plan-clear-failed");
    try {
      spyOn(t.internals, "clearHistoryThroughCompactionCancellation").mockImplementationOnce(
        async () => {
          // At the commit point the plan is already aside, so it has to be put back.
          expect(existsSync(t.planPath)).toBe(false);
          expect(await t.asideFiles()).toHaveLength(1);
          return Err("history write failed");
        }
      );
      const cleared = await t.clearer.truncateHistory("plan-clear-failed", 1.0);
      expect(cleared.success).toBe(false);
      expect(await fsPromises.readFile(t.planPath, "utf8")).toBe("# Plan\n\nBefore the clear.\n");
      expect(await t.asideFiles()).toEqual([]);
    } finally {
      await t.teardown();
    }
  });

  test("a failed clear keeps a plan written while it ran instead of the older one", async () => {
    const t = await setup("plan-clear-failed-rewritten");
    try {
      spyOn(t.internals, "clearHistoryThroughCompactionCancellation").mockImplementationOnce(
        async () => {
          await fsPromises.writeFile(t.planPath, "# Plan\n\nWritten during the clear.\n");
          return Err("history write failed");
        }
      );
      const cleared = await t.clearer.truncateHistory("plan-clear-failed-rewritten", 1.0);
      expect(cleared.success).toBe(false);
      expect(await fsPromises.readFile(t.planPath, "utf8")).toBe(
        "# Plan\n\nWritten during the clear.\n"
      );
      expect(await t.asideFiles()).toEqual([]);
    } finally {
      await t.teardown();
    }
  });

  test("a clear that fails after its history commit does not bring the plan back", async () => {
    const t = await setup("plan-clear-post-commit-failure");
    try {
      // Bookkeeping after the deletion receipt can still throw; the clear has committed, so the
      // moved-aside plan must be removed, not restored for a later capture to read.
      const reconciler = (
        t.clearer as unknown as {
          bashMonitorWakeReconciler: { finishFullHistoryClear: (token: unknown) => Promise<void> };
        }
      ).bashMonitorWakeReconciler;
      spyOn(reconciler, "finishFullHistoryClear").mockRejectedValueOnce(
        new Error("monitor bookkeeping failed")
      );
      let thrown: unknown;
      try {
        await t.clearer.truncateHistory("plan-clear-post-commit-failure", 1.0);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      const history = await t.other().getLastMessages("plan-clear-post-commit-failure", 5);
      expect(history.success && history.data).toEqual([]);
      expect(existsSync(t.planPath)).toBe(false);
      expect(await t.asideFiles()).toEqual([]);
      const captured = await t.capture();
      expect(captured.success === false && captured.error.type).toBe("plan_missing");
    } finally {
      await t.teardown();
    }
  });

  test("a normal clear deletes the plan file and leaves nothing aside", async () => {
    const t = await setup("plan-clear-normal");
    try {
      const cleared = await t.clearer.truncateHistory("plan-clear-normal", 1.0);
      expect(cleared.success).toBe(true);
      expect(existsSync(t.planPath)).toBe(false);
      expect(await t.asideFiles()).toEqual([]);
      // With the plan gone, a later capture has nothing to snapshot.
      const captured = await t.capture();
      expect(captured.success === false && captured.error.type).toBe("plan_missing");
    } finally {
      await t.teardown();
    }
  });
});
