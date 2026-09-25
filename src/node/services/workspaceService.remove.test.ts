import { describe, expect, test, mock, beforeEach, afterEach, spyOn } from "bun:test";
import { ContextManagementService } from "./contextManagement/contextManagementService";
import { WorkspaceService } from "./workspaceService";
import { createStreamLifecycleMocks } from "./agentSession.testHarness";
import { EventEmitter } from "events";
import { existsSync } from "fs";
import * as fsPromises from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { Err, Ok, type Result } from "@/common/types/result";
import { SCRATCH_PROJECT_CONFIG_KEY } from "@/common/constants/scratch";
import type { Config } from "@/node/config";
import type { HistoryService } from "./historyService";
import { createTestHistoryService } from "./testHistoryService";
import { createTestProject, saveWorkspaces } from "./taskService.testHarness";
import type { SessionTimingService } from "./sessionTimingService";
import type { SessionUsageService } from "./sessionUsageService";
import type { AIService } from "./aiService";
import type { InitStateManager } from "./initStateManager";
import type { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { FrontendWorkspaceMetadata, WorkspaceMetadata } from "@/common/types/workspace";
import { makeAgentTaskIntegrationFake } from "./taskWorkspaceSeam.testUtils";
import { resolveWorkspaceMemoryOwnerId } from "./memoryWorkspaceOwner";
import { isWorkspaceRemovalTombstoned } from "./workspaceRemoval";
import { MemoryService } from "./memoryService";
import { MemoryMetaService } from "./memoryMeta";
import type { DesktopSessionManager } from "@/node/services/desktop/DesktopSessionManager";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import * as removeManagedGitWorktreeModule from "@/node/worktree/removeManagedGitWorktree";
import type { MockWorkspaceConfig } from "./workspaceService.testHarness";
import {
  mockInitStateManager,
  mockExtensionMetadataService,
  createTestBackgroundProcessManager,
  createMockAIService,
  createWorkspaceServiceForTest,
} from "./workspaceService.testHarness";

describe("WorkspaceService remove lifecycle coordination", () => {
  test("acknowledged removal keeps the parent last and returns forced failure scope", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceService = createWorkspaceServiceForTest({ config, historyService });
    let notifications = 0;
    const unsubscribe = config.onConfigChanged(() => {
      notifications += 1;
    });
    const descendants = [{ workspaceId: "child", title: "Child", active: true }];
    const order: string[] = [];
    let locked = false;
    let blocked = true;
    const removeDescendants = mock(async () => {
      expect(locked).toBe(true);
      const before = notifications;
      order.push("descendants");
      await config.editConfig((value) => value);
      await config.editConfig((value) => value);
      expect(notifications).toBe(before);
      return blocked ? Err("active child") : Ok(undefined);
    });
    workspaceService.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({
        withTaskTreeLifecycleLock: async <T>(
          _id: string,
          operation: () => Promise<T>
        ): Promise<T> => {
          expect(locked).toBe(false);
          locked = true;
          try {
            return await operation();
          } finally {
            locked = false;
          }
        },
        listWorkspaceRemovalDescendants: () => descendants,
        removeAcknowledgedDescendantsWhileTaskTreeLocked: removeDescendants,
      })
    );
    const removeParent = spyOn(
      workspaceService as unknown as {
        removeUnlocked(id: string, force: boolean): Promise<Result<void>>;
      },
      "removeUnlocked"
    ).mockImplementation(async () => {
      expect(locked).toBe(true);
      order.push("parent");
      await config.editConfig((value) => value);
      return Err("parent failure");
    });
    expect(
      await workspaceService.remove("parent", true, { acknowledgedDescendantIds: ["child"] })
    ).toEqual({
      success: false,
      error: "active child",
      descendants,
    });
    expect(removeParent).not.toHaveBeenCalled();
    blocked = false;
    expect(
      await workspaceService.remove("parent", true, { acknowledgedDescendantIds: ["child"] })
    ).toEqual({
      success: false,
      error: "parent failure",
      descendants,
    });
    expect(order).toEqual(["descendants", "descendants", "parent"]);
    expect(notifications).toBe(2);
    removeDescendants.mockClear();
    expect(await workspaceService.remove("parent", true)).toEqual({
      success: false,
      error: "parent failure",
      descendants,
    });
    expect(removeDescendants).not.toHaveBeenCalled();
    expect(notifications).toBe(3);
    unsubscribe();
    removeParent.mockRestore();
    await cleanup();
  });

  test("checks descendant tasks while holding the task-tree lifecycle lock", async () => {
    const workspaceId = "parent-remove-lifecycle";
    const workspaceService = createWorkspaceServiceForTest({
      config: {
        findWorkspace: mock(() => null),
      },
    });
    let insideLifecycleLock = false;
    const withTaskTreeLifecycleLock = mock(
      (_workspaceId: string, _operation: () => Promise<unknown>) => undefined
    );
    const runWithTaskTreeLifecycleLock = async <T>(
      workspaceId: string,
      operation: () => Promise<T>
    ): Promise<T> => {
      withTaskTreeLifecycleLock(workspaceId, operation);
      insideLifecycleLock = true;
      try {
        return await operation();
      } finally {
        insideLifecycleLock = false;
      }
    };
    const hasDescendantAgentTasks = mock(() => {
      expect(insideLifecycleLock).toBe(true);
      return true;
    });
    workspaceService.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({
        withTaskTreeLifecycleLock: runWithTaskTreeLifecycleLock,
        hasDescendantAgentTasks,
      })
    );

    expect(await workspaceService.remove(workspaceId, true)).toEqual(
      Err(
        "This workspace has descendant sub-agent workspaces. Remove those descendants deepest-first before removing their parent."
      )
    );
    expect(withTaskTreeLifecycleLock).toHaveBeenCalledWith(workspaceId, expect.any(Function));
    expect(hasDescendantAgentTasks).toHaveBeenCalledWith(workspaceId);
  });
});

describe("WorkspaceService remove timing rollup", () => {
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("waits for stream-abort before rolling up session timing", async () => {
    const workspaceId = "child-ws";
    const parentWorkspaceId = "parent-ws";

    const tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-remove-"));
    const stopEntered = Promise.withResolvers<void>();
    const stopRelease = Promise.withResolvers<void>();
    try {
      const sessionRoot = path.join(tempRoot, "sessions");
      await fsPromises.mkdir(path.join(sessionRoot, workspaceId), { recursive: true });

      let abortEmitted = false;
      let rollUpSawAbort = false;

      class FakeAIService extends EventEmitter {
        isStreaming = mock(() => true);

        stopStream = mock(async () => {
          stopEntered.resolve();
          await stopRelease.promise;
          abortEmitted = true;
          this.emit("stream-abort", {
            type: "stream-abort",
            workspaceId,
            messageId: "msg",
            abortReason: "system",
            metadata: { duration: 123 },
            abandonPartial: true,
          });
          return { success: true as const, data: undefined };
        });

        getWorkspaceMetadata = mock(() =>
          Promise.resolve({
            success: true as const,
            data: {
              id: workspaceId,
              name: "child",
              projectPath: "/tmp/proj",
              runtimeConfig: { type: "local" },
              parentWorkspaceId,
            },
          })
        );
      }

      const aiService = new FakeAIService() as unknown as AIService;
      const mockConfig: MockWorkspaceConfig = {
        rootDir: path.join(tempRoot, "root"),
        srcDir: "/tmp/src",
        sessionsDir: sessionRoot,
        removeWorkspace: mock(() => Promise.resolve()),
        findWorkspace: mock(() => null),
        loadConfigOrDefault: mock(() => ({ projects: new Map() })),
      };

      const timingService: Partial<SessionTimingService> = {
        waitForIdle: mock(() => Promise.resolve()),
        rollUpTimingIntoParent: mock(() => {
          rollUpSawAbort = abortEmitted;
          return Promise.resolve({ didRollUp: true });
        }),
      };

      const workspaceService = new WorkspaceService(
        mockConfig as Config,
        historyService,
        aiService,
        new ContextManagementService({ config: mockConfig as Config, historyService, aiService }),
        mockInitStateManager as InitStateManager,
        mockExtensionMetadataService as ExtensionMetadataService,
        createTestBackgroundProcessManager(),
        undefined, // sessionUsageService
        undefined, // policyService
        undefined, // telemetryService
        undefined, // experimentsService
        timingService as SessionTimingService
      );

      const removing = workspaceService.remove(workspaceId, true);
      await stopEntered.promise;
      expect(timingService.rollUpTimingIntoParent).not.toHaveBeenCalled();
      stopRelease.resolve();
      const removeResult = await removing;
      expect(removeResult.success).toBe(true);
      expect(mockInitStateManager.clearInMemoryState).toHaveBeenCalledWith(workspaceId);
      expect(rollUpSawAbort).toBe(true);
    } finally {
      stopRelease.resolve();
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("WorkspaceService remove sub-agent handover ordering", () => {
  // A sub-agent's final shared-memory handover + removal tombstone are sealed
  // under the removal locks BEFORE the checkout is deleted: a handover the
  // owner store cannot take aborts with the checkout intact, and a refused
  // checkout deletion rolls the tombstone back.
  const projectPath = "/tmp/proj-handover";
  const workspaceId = "child-handover";
  const ownerId = "owner-handover";
  const workspacePath = path.join(projectPath, "child-ws");
  const runtimeConfig = { type: "worktree" as const, srcBaseDir: "/tmp/src" };
  let rootDir: string;

  beforeEach(async () => {
    rootDir = path.join(tmpdir(), "mux-handover-order", `root-${crypto.randomUUID()}`);
    await fsPromises.mkdir(path.join(rootDir, "sessions", workspaceId), { recursive: true });
  });
  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  function buildConfig(): Partial<Config> {
    const topology = {
      projects: new Map([
        [
          projectPath,
          {
            trusted: true,
            workspaces: [
              {
                id: ownerId,
                name: "owner",
                path: path.join(projectPath, "owner-ws"),
                runtimeConfig,
              },
              {
                id: workspaceId,
                name: "child",
                path: workspacePath,
                runtimeConfig,
                parentWorkspaceId: ownerId,
              },
            ],
          },
        ],
      ]),
    };
    return {
      rootDir,
      srcDir: "/tmp/src",
      sessionsDir: path.join(rootDir, "sessions"),
      removeWorkspace: mock(() => Promise.resolve()),
      findWorkspace: mock(() => ({ workspacePath, projectPath })),
      loadConfigOrDefault: mock(() => topology),
      editConfig: mock((edit: (cfg: typeof topology) => typeof topology) =>
        Promise.resolve(edit(topology))
      ),
    } as unknown as Partial<Config>;
  }

  function buildAiService(): AIService {
    return {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      stopStream: mock(() => Promise.resolve(Ok(undefined))),
      getWorkspaceMetadata: mock(() =>
        Promise.resolve(
          Ok({
            id: workspaceId,
            name: "child",
            projectPath,
            projectName: "proj",
            runtimeConfig,
            parentWorkspaceId: ownerId,
          })
        )
      ),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;
  }

  test("a handover the owner cannot take aborts before the checkout is deleted", async () => {
    const deleteWorkspace = mock(() =>
      Promise.resolve({ success: true as const, deletedPath: workspacePath })
    );
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
    try {
      const workspaceService = createWorkspaceServiceForTest({
        config: buildConfig(),
        aiService: buildAiService(),
      });
      let adoptions = 0;
      workspaceService.setSharedWorkspaceMemoryStore({
        adoptLegacyPrivateStoreForRemoval: (_child, _owner, options) => {
          adoptions++;
          // The unlocked pre-pass succeeds; the late note appears for the
          // locked pass, which cannot place it.
          return options?.locksHeld
            ? Promise.reject(new Error("1 legacy note could not be folded"))
            : Promise.resolve();
        },
      });
      const result = await workspaceService.remove(workspaceId);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain("could not be folded");
      expect(adoptions).toBe(2);
      expect(deleteWorkspace).not.toHaveBeenCalled();
      expect(existsSync(path.join(rootDir, "sessions", workspaceId))).toBe(true);
      expect(await isWorkspaceRemovalTombstoned(rootDir, workspaceId)).toBe(false);
      // force accepts the loss and completes the removal.
      expect((await workspaceService.remove(workspaceId, true)).success).toBe(true);
      expect(deleteWorkspace).toHaveBeenCalledTimes(1);
      expect(existsSync(path.join(rootDir, "sessions", workspaceId))).toBe(false);
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });

  test("a teardown step failing after the seal rolls the tombstone back and releases the gate", async () => {
    const deleteWorkspace = mock(() =>
      Promise.resolve({ success: true as const, deletedPath: workspacePath })
    );
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
    try {
      const config = buildConfig();
      const workspaceService = createWorkspaceServiceForTest({
        config,
        aiService: buildAiService(),
      });
      workspaceService.setSharedWorkspaceMemoryStore({
        adoptLegacyPrivateStoreForRemoval: () => Promise.resolve(),
      });
      // The consolidation drain runs once before the seal and again after the
      // checkout deletion; the second call stands in for any teardown step
      // that rejects once the child is durably tombstoned.
      const calls: string[] = [];
      let cancels = 0;
      let failSecondCancel = true;
      workspaceService.setMemoryConsolidationService({
        triggerInBackground: () => undefined,
        triggerHarvestThenSweepInBackground: () => undefined,
        cancelInFlightConsolidation: () => {
          calls.push("cancel");
          cancels++;
          return cancels === 2 && failSecondCancel
            ? Promise.reject(new Error("sandbox teardown failed"))
            : Promise.resolve();
        },
        releaseRemovalCancellation: () => {
          calls.push("release");
        },
        finalizeHarvestsForRemoval: () => {
          calls.push("finalize");
          return Promise.resolve();
        },
      });
      const failed = await workspaceService.remove(workspaceId);
      expect(failed.success).toBe(false);
      if (!failed.success) expect(failed.error).toContain("sandbox teardown failed");
      // Still registered: the sealed marker is gone, the gate lifted, and
      // nothing was finalized.
      expect(config.removeWorkspace).not.toHaveBeenCalled();
      expect(await isWorkspaceRemovalTombstoned(rootDir, workspaceId)).toBe(false);
      expect(existsSync(path.join(rootDir, "sessions", workspaceId))).toBe(true);
      expect(calls).toContain("release");
      expect(calls).not.toContain("finalize");
      // The child's memory works again: its shared-store write is not
      // refused by a stale tombstone.
      const memoryService = new MemoryService(
        {
          rootDir,
          sessionsDir: path.join(rootDir, "sessions"),
          loadConfigOrDefault: config.loadConfigOrDefault,
          configFileStamp: () => "stable",
          onConfigChanged: () => undefined,
        } as unknown as Config,
        new MemoryMetaService(rootDir)
      );
      const created = await memoryService.create(
        { runtime: null, checkoutCwd: "", workspaceId, projectPath: "" },
        "/memories/workspace/after-abort.md",
        "still usable",
        "agent"
      );
      expect(created.success).toBe(true);
      // A retried removal completes: cancelled, tombstoned, finalized, not released.
      failSecondCancel = false;
      calls.length = 0;
      expect((await workspaceService.remove(workspaceId)).success).toBe(true);
      expect(await isWorkspaceRemovalTombstoned(rootDir, workspaceId)).toBe(true);
      expect(calls).toContain("finalize");
      expect(calls).not.toContain("release");
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });

  test("a refused checkout deletion rolls the sealed tombstone back", async () => {
    let refuse = true;
    const deleteWorkspace = mock(() =>
      Promise.resolve(
        refuse
          ? { success: false as const, error: "Workspace has uncommitted changes" }
          : { success: true as const, deletedPath: workspacePath }
      )
    );
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
    try {
      const workspaceService = createWorkspaceServiceForTest({
        config: buildConfig(),
        aiService: buildAiService(),
      });
      let sealedTombstone = false;
      workspaceService.setSharedWorkspaceMemoryStore({
        adoptLegacyPrivateStoreForRemoval: () => Promise.resolve(),
      });
      deleteWorkspace.mockImplementation(async () => {
        // Runtime deletion runs with the tombstone already sealed.
        sealedTombstone = await isWorkspaceRemovalTombstoned(rootDir, workspaceId);
        return refuse
          ? { success: false as const, error: "Workspace has uncommitted changes" }
          : { success: true as const, deletedPath: workspacePath };
      });
      const refused = await workspaceService.remove(workspaceId);
      expect(refused.success).toBe(false);
      if (!refused.success) expect(refused.error).toContain("uncommitted changes");
      expect(sealedTombstone).toBe(true);
      expect(await isWorkspaceRemovalTombstoned(rootDir, workspaceId)).toBe(false);
      expect(existsSync(path.join(rootDir, "sessions", workspaceId))).toBe(true);
      refuse = false;
      expect((await workspaceService.remove(workspaceId)).success).toBe(true);
      expect(await isWorkspaceRemovalTombstoned(rootDir, workspaceId)).toBe(true);
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });
});

describe("WorkspaceService remove shared-workspace guard", () => {
  const projectPath = "/tmp/proj-shared";
  const workspaceId = "child-shared";
  const sharedPath = path.join(projectPath, "parent-ws");
  const runtimeConfig = { type: "worktree" as const, srcBaseDir: "/tmp/src" };

  function buildConfig(taskIsolation?: "none" | "fork"): Partial<Config> {
    return {
      // Unique per-build root: removal publishes durable tombstones under
      // <rootDir>/locks, which must not leak across tests or runs.
      rootDir: path.join(tmpdir(), "mux-shared-guard", `root-${crypto.randomUUID()}`),
      srcDir: "/tmp/src",
      sessionsDir: path.join(tmpdir(), "mux-shared-guard"),
      removeWorkspace: mock(() => Promise.resolve()),
      findWorkspace: mock(() => ({ workspacePath: sharedPath, projectPath })),
      loadConfigOrDefault: mock(() => ({
        projects: new Map([
          [
            projectPath,
            {
              trusted: true,
              workspaces: [
                {
                  id: workspaceId,
                  name: "agent_explore_child",
                  path: sharedPath,
                  runtimeConfig,
                  taskIsolation,
                },
              ],
            },
          ],
        ]),
      })),
    } as unknown as Partial<Config>;
  }

  function buildAiService(): AIService {
    class FakeAIService extends EventEmitter {
      isStreaming = mock(() => false);
      stopStream = mock(() => Promise.resolve({ success: true as const, data: undefined }));
      getWorkspaceMetadata = mock(() =>
        Promise.resolve({
          success: true as const,
          data: {
            id: workspaceId,
            name: "agent_explore_child",
            projectPath,
            runtimeConfig,
          },
        })
      );
    }
    return new FakeAIService() as unknown as AIService;
  }

  test("does not delete the shared parent checkout for isolation: none tasks", async () => {
    const deleteWorkspace = mock(() =>
      Promise.resolve({ success: true as const, deletedPath: sharedPath })
    );
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
    try {
      const workspaceService = createWorkspaceServiceForTest({
        config: buildConfig("none"),
        aiService: buildAiService(),
      });

      const result = await workspaceService.remove(workspaceId, true);
      expect(result.success).toBe(true);
      // The parent's checkout must never be physically deleted on behalf of a shared task.
      expect(deleteWorkspace).not.toHaveBeenCalled();
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });

  test("deletes the workspace for normal (forked) tasks", async () => {
    const deleteWorkspace = mock(() =>
      Promise.resolve({ success: true as const, deletedPath: sharedPath })
    );
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
    try {
      const workspaceService = createWorkspaceServiceForTest({
        config: buildConfig(undefined),
        aiService: buildAiService(),
      });

      const result = await workspaceService.remove(workspaceId, true);
      expect(result.success).toBe(true);
      expect(deleteWorkspace).toHaveBeenCalledTimes(1);
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });

  // Inverse direction: removing the PARENT while a live shared child points at its checkout.
  function buildParentConfig(childTaskStatus: string): Partial<Config> {
    return {
      rootDir: path.join(tmpdir(), "mux-shared-guard", `root-${crypto.randomUUID()}`),
      srcDir: "/tmp/src",
      sessionsDir: path.join(tmpdir(), "mux-shared-guard"),
      removeWorkspace: mock(() => Promise.resolve()),
      findWorkspace: mock(() => ({ workspacePath: sharedPath, projectPath })),
      loadConfigOrDefault: mock(() => ({
        projects: new Map([
          [
            projectPath,
            {
              trusted: true,
              workspaces: [
                {
                  id: "parent-ws-id",
                  name: "parent-ws",
                  path: sharedPath,
                  runtimeConfig,
                },
                {
                  id: workspaceId,
                  name: "agent_explore_child",
                  path: sharedPath,
                  runtimeConfig,
                  parentWorkspaceId: "parent-ws-id",
                  taskIsolation: "none",
                  taskStatus: childTaskStatus,
                },
              ],
            },
          ],
        ]),
      })),
    } as unknown as Partial<Config>;
  }

  function buildParentAiService(): AIService {
    class FakeAIService extends EventEmitter {
      isStreaming = mock(() => false);
      stopStream = mock(() => Promise.resolve({ success: true as const, data: undefined }));
      getWorkspaceMetadata = mock(() =>
        Promise.resolve({
          success: true as const,
          data: {
            id: "parent-ws-id",
            name: "parent-ws",
            projectPath,
            runtimeConfig,
          },
        })
      );
    }
    return new FakeAIService() as unknown as AIService;
  }

  test("does not delete a parent checkout shared by an active isolation: none child", async () => {
    const deleteWorkspace = mock(() =>
      Promise.resolve({ success: true as const, deletedPath: sharedPath })
    );
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
    try {
      const workspaceService = createWorkspaceServiceForTest({
        config: buildParentConfig("running"),
        aiService: buildParentAiService(),
      });

      const result = await workspaceService.remove("parent-ws-id", true);
      expect(result.success).toBe(true);
      // The running shared child still uses this checkout as its cwd.
      expect(deleteWorkspace).not.toHaveBeenCalled();
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });

  test("deletes a parent checkout when its shared child is only queued (fails fast at dequeue like forked tasks)", async () => {
    const deleteWorkspace = mock(() =>
      Promise.resolve({ success: true as const, deletedPath: sharedPath })
    );
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
    try {
      const workspaceService = createWorkspaceServiceForTest({
        config: buildParentConfig("queued"),
        aiService: buildParentAiService(),
      });

      const result = await workspaceService.remove("parent-ws-id", true);
      expect(result.success).toBe(true);
      // Queued children require the parent config entry to launch regardless of isolation, so
      // they fail fast at dequeue either way — preserving the checkout would only leak it.
      expect(deleteWorkspace).toHaveBeenCalledTimes(1);
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });

  test("deletes a parent checkout when its shared child already reported", async () => {
    const deleteWorkspace = mock(() =>
      Promise.resolve({ success: true as const, deletedPath: sharedPath })
    );
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
    try {
      const workspaceService = createWorkspaceServiceForTest({
        config: buildParentConfig("reported"),
        aiService: buildParentAiService(),
      });

      const result = await workspaceService.remove("parent-ws-id", true);
      expect(result.success).toBe(true);
      expect(deleteWorkspace).toHaveBeenCalledTimes(1);
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });
});

describe("WorkspaceService shared-checkout tasks and owner renames", () => {
  const ownerId = "owner-shared-rename";
  const childId = "child-shared-rename";
  let config: Config;
  let historyService: HistoryService;
  let cleanup: () => Promise<void>;
  let workspaceService: WorkspaceService;
  let projectPath: string;
  let ownerPath: string;

  beforeEach(async () => {
    ({ config, historyService, cleanup } = await createTestHistoryService());
    projectPath = await createTestProject(config.rootDir);
    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = runtimeFactory.createRuntime(runtimeConfig, { projectPath });
    const created = await runtime.createWorkspace({
      projectPath,
      branchName: "parent",
      trunkBranch: "main",
      directoryName: "parent",
      initLogger: {
        logStep: () => undefined,
        logStdout: () => undefined,
        logStderr: () => undefined,
        logComplete: () => undefined,
        enterHookPhase: () => undefined,
      },
    });
    expect(created.success).toBe(true);
    ownerPath = runtime.getWorkspacePath(projectPath, "parent");
    await saveWorkspaces(config, projectPath, [
      { id: ownerId, name: "parent", path: ownerPath, runtimeConfig },
      {
        id: childId,
        name: "agent_explore_child",
        path: ownerPath,
        runtimeConfig,
        parentWorkspaceId: ownerId,
        taskIsolation: "none",
        taskStatus: "reported",
        taskTrunkBranch: "parent",
      },
    ]);

    class FakeAIService extends EventEmitter {
      isStreaming = mock(() => false);
      stopStream = mock(() => Promise.resolve(Ok(undefined)));
      getWorkspaceMetadata = mock(async (workspaceId: string) => {
        const metadata = await config.getWorkspaceMetadataById(workspaceId);
        return metadata ? Ok(metadata) : Err("not found");
      });
    }
    workspaceService = createWorkspaceServiceForTest({
      config,
      historyService,
      aiService: new FakeAIService() as unknown as AIService,
    });
  });

  afterEach(async () => {
    await cleanup();
  });

  test("refuses to rename a shared child before touching any runtime", async () => {
    // Override-aware runtimes (SSH) would otherwise move the owner's checkout.
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime");
    let result: Result<{ newWorkspaceId: string }>;
    try {
      result = await workspaceService.rename(childId, "moved-child");
      expect(createRuntimeSpy).not.toHaveBeenCalled();
    } finally {
      createRuntimeSpy.mockRestore();
    }

    expect(result.success).toBe(false);
    expect(existsSync(ownerPath)).toBe(true);
    expect(config.findWorkspace(childId)?.workspacePath).toBe(ownerPath);
    expect(config.findWorkspace(ownerId)?.workspacePath).toBe(ownerPath);
  });

  test("accepts renaming a shared child to its current name as a no-op", async () => {
    const result = await workspaceService.rename(childId, "agent_explore_child");

    expect(result.success).toBe(true);
    expect(config.findWorkspace(childId)?.workspacePath).toBe(ownerPath);
  });

  test("shared children follow an owner rename and removing one keeps the renamed checkout", async () => {
    const emittedChildPaths: Array<string | undefined> = [];
    workspaceService.on(
      "metadata",
      (event: { workspaceId: string; metadata: FrontendWorkspaceMetadata | null }) => {
        if (event.workspaceId === childId) {
          emittedChildPaths.push(event.metadata?.namedWorkspacePath);
        }
      }
    );
    const renamed = await workspaceService.rename(ownerId, "renamed-parent");
    expect(renamed.success).toBe(true);
    const renamedOwnerPath = config.findWorkspace(ownerId)?.workspacePath;
    if (renamedOwnerPath == null) throw new Error("renamed owner is missing from config");
    expect(renamedOwnerPath).not.toBe(ownerPath);
    expect(config.findWorkspace(childId)?.workspacePath).toBe(renamedOwnerPath);
    expect(emittedChildPaths).toEqual([renamedOwnerPath]);

    const removed = await workspaceService.remove(childId, true);

    expect(removed.success).toBe(true);
    expect(config.findWorkspace(childId)).toBeNull();
    expect(existsSync(path.join(renamedOwnerPath, "README.md"))).toBe(true);
  });

  test("removing a renamed owner keeps the checkout an active shared child still uses", async () => {
    expect((await workspaceService.rename(ownerId, "renamed-parent")).success).toBe(true);
    const renamedOwnerPath = config.findWorkspace(ownerId)?.workspacePath;
    if (renamedOwnerPath == null) throw new Error("renamed owner is missing from config");
    await config.editConfig((cfg) => {
      const child = cfg.projects.get(projectPath)?.workspaces.find((ws) => ws.id === childId);
      if (child) child.taskStatus = "running";
      return cfg;
    });

    const removed = await workspaceService.remove(ownerId, true);

    expect(removed.success).toBe(true);
    expect(existsSync(path.join(renamedOwnerPath, "README.md"))).toBe(true);
  });
});

describe("WorkspaceService remove shared memory owner pinning", () => {
  const projectPath = "/tmp/proj-memory-pin";
  const runtimeConfig = { type: "worktree" as const, srcBaseDir: "/tmp/src" };
  interface Entry {
    id: string;
    name: string;
    path: string;
    runtimeConfig: typeof runtimeConfig;
    parentWorkspaceId?: string;
    memoryOwnerWorkspaceId?: string;
  }

  /** owner → mid → grand: removing `mid` must keep `grand` on the owner's notebook. */
  function buildTopology(): { projects: Map<string, { trusted: boolean; workspaces: Entry[] }> } {
    return {
      projects: new Map([
        [
          projectPath,
          {
            trusted: true,
            workspaces: [
              { id: "ws-owner", name: "owner", path: `${projectPath}/owner`, runtimeConfig },
              {
                id: "ws-mid",
                name: "mid",
                path: `${projectPath}/mid`,
                runtimeConfig,
                parentWorkspaceId: "ws-owner",
              },
              {
                id: "ws-grand",
                name: "grand",
                path: `${projectPath}/grand`,
                runtimeConfig,
                parentWorkspaceId: "ws-mid",
              },
            ],
          },
        ],
      ]),
    };
  }

  function buildConfig(options: { persistPins: boolean }): {
    config: Partial<Config>;
    topology: ReturnType<typeof buildTopology>;
  } {
    const topology = buildTopology();
    const config = {
      rootDir: path.join(tmpdir(), "mux-memory-pin", `root-${crypto.randomUUID()}`),
      srcDir: "/tmp/src",
      sessionsDir: path.join(tmpdir(), "mux-memory-pin", `sessions-${crypto.randomUUID()}`),
      removeWorkspace: mock(() => Promise.resolve()),
      findWorkspace: mock(() => ({ workspacePath: `${projectPath}/mid`, projectPath })),
      loadConfigOrDefault: mock(() => topology),
      // Config swallows write failures: a pin that does not land must be
      // caught by the removal's verified read-back, so the no-persist variant
      // applies the edit to a throwaway copy.
      editConfig: mock((edit: (cfg: ReturnType<typeof buildTopology>) => unknown) => {
        edit(options.persistPins ? topology : buildTopology());
        return Promise.resolve();
      }),
    } as unknown as Partial<Config>;
    return { config, topology };
  }

  function buildAiService(): AIService {
    class FakeAIService extends EventEmitter {
      isStreaming = mock(() => false);
      stopStream = mock(() => Promise.resolve({ success: true as const, data: undefined }));
      getWorkspaceMetadata = mock(() =>
        Promise.resolve({
          success: true as const,
          data: { id: "ws-mid", name: "mid", projectPath, runtimeConfig },
        })
      );
    }
    return new FakeAIService() as unknown as AIService;
  }

  test("pins surviving descendants to the root owner before tearing the middle node down", async () => {
    const deleteWorkspace = mock(() =>
      Promise.resolve({ success: true as const, deletedPath: `${projectPath}/mid` })
    );
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
    const { config, topology } = buildConfig({ persistPins: true });
    try {
      const workspaceService = createWorkspaceServiceForTest({
        config,
        aiService: buildAiService(),
      });
      const result = await workspaceService.remove("ws-mid");
      expect(result.success).toBe(true);
      expect(deleteWorkspace).toHaveBeenCalledTimes(1);
      const grand = topology.projects
        .get(projectPath)!
        .workspaces.find((ws) => ws.id === "ws-grand");
      expect(grand?.memoryOwnerWorkspaceId).toBe("ws-owner");
      // Once ws-mid is gone the pin keeps ws-grand on the root's notebook.
      topology.projects.get(projectPath)!.workspaces = topology.projects
        .get(projectPath)!
        .workspaces.filter((ws) => ws.id !== "ws-mid");
      expect(resolveWorkspaceMemoryOwnerId(topology as never, "ws-grand")).toBe("ws-owner");
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });

  test("aborts a non-forced removal (workspace intact) when the descendant pin does not persist", async () => {
    const deleteWorkspace = mock(() =>
      Promise.resolve({ success: true as const, deletedPath: `${projectPath}/mid` })
    );
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
    const { config } = buildConfig({ persistPins: false });
    try {
      const workspaceService = createWorkspaceServiceForTest({
        config,
        aiService: buildAiService(),
      });
      const refused = await workspaceService.remove("ws-mid");
      expect(refused.success).toBe(false);
      if (!refused.success) expect(refused.error).toContain("retry the removal");
      // Nothing destructive ran: no checkout deletion, no deregistration.
      expect(deleteWorkspace).not.toHaveBeenCalled();
      expect(config.removeWorkspace).not.toHaveBeenCalled();

      // Forced removal accepts the loss and proceeds.
      const forced = await workspaceService.remove("ws-mid", true);
      expect(forced.success).toBe(true);
      expect(deleteWorkspace).toHaveBeenCalledTimes(1);
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });

  test("aborts a non-forced removal when the owner cannot be resolved from a readable config", async () => {
    // An unreadable config.json: the lenient read yields an empty topology
    // (this workspace would look like its own owner — no pins, no handover),
    // the strict one throws. The removal must decide from the strict read.
    const deleteWorkspace = mock(() =>
      Promise.resolve({ success: true as const, deletedPath: `${projectPath}/mid` })
    );
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
    const { config } = buildConfig({ persistPins: true });
    const loadConfigOrDefault = mock((options?: { throwOnError?: boolean }) => {
      if (options?.throwOnError === true) throw new Error("config.json unreadable (EIO)");
      return { projects: new Map() };
    });
    (config as { loadConfigOrDefault: unknown }).loadConfigOrDefault = loadConfigOrDefault;
    try {
      const workspaceService = createWorkspaceServiceForTest({
        config,
        aiService: buildAiService(),
      });
      const refused = await workspaceService.remove("ws-mid");
      expect(refused.success).toBe(false);
      if (!refused.success) {
        expect(refused.error).toContain("config.json unreadable");
        expect(refused.error).toContain("retry the removal");
      }
      expect(deleteWorkspace).not.toHaveBeenCalled();
      expect(config.removeWorkspace).not.toHaveBeenCalled();
      expect(config.editConfig).not.toHaveBeenCalled();

      // Forced removal accepts the loss and proceeds.
      const forced = await workspaceService.remove("ws-mid", true);
      expect(forced.success).toBe(true);
      expect(deleteWorkspace).toHaveBeenCalledTimes(1);
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });

  test("pins surviving descendants even when the removed node's metadata cannot be built", async () => {
    // The phantom-cleanup path: no metadata, yet the config entry is removed
    // all the same — the pin is a config-only edit and must still land, or a
    // surviving child silently falls back to a private notebook.
    class PhantomAiService extends EventEmitter {
      isStreaming = mock(() => false);
      stopStream = mock(() => Promise.resolve({ success: true as const, data: undefined }));
      getWorkspaceMetadata = mock(() =>
        Promise.resolve({ success: false as const, error: "metadata unavailable" })
      );
    }
    const { config, topology } = buildConfig({ persistPins: true });
    const workspaceService = createWorkspaceServiceForTest({
      config,
      aiService: new PhantomAiService() as unknown as AIService,
    });
    const result = await workspaceService.remove("ws-mid");
    expect(result.success).toBe(true);
    expect(config.removeWorkspace).toHaveBeenCalledTimes(1);
    const grand = topology.projects.get(projectPath)!.workspaces.find((ws) => ws.id === "ws-grand");
    expect(grand?.memoryOwnerWorkspaceId).toBe("ws-owner");

    // ...and a pin that does not persist still aborts the non-forced removal
    // on that path, before the config entry is dropped.
    const unpersisted = buildConfig({ persistPins: false });
    const refusing = createWorkspaceServiceForTest({
      config: unpersisted.config,
      aiService: new PhantomAiService() as unknown as AIService,
    });
    const refused = await refusing.remove("ws-mid");
    expect(refused.success).toBe(false);
    expect(unpersisted.config.removeWorkspace).not.toHaveBeenCalled();
  });
});

describe("WorkspaceService remove desktop session cleanup", () => {
  const workspaceId = "ws-remove-desktop";

  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let workspaceService: WorkspaceService;
  let removeWorkspaceMock: ReturnType<typeof mock>;
  let tempRoot: string;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
    tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-remove-desktop-"));
    removeWorkspaceMock = mock(() => Promise.resolve());

    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      stopStream: mock(() => Promise.resolve(Ok(undefined))),
      getWorkspaceMetadata: mock(() => Promise.resolve(Err("not found"))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/src",
      // r63: removal serializes session-dir deletion with the memory target
      // locks and removal tombstones under `<rootDir>/locks`.
      rootDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      removeWorkspace: removeWorkspaceMock,
      findWorkspace: mock(() => null),
      loadConfigOrDefault: mock(() => ({ projects: new Map() })),
      // The descendant pin pass edits whatever topology a test installed.
      editConfig: mock((edit: (cfg: unknown) => unknown) => {
        edit(mockConfig.loadConfigOrDefault!());
        return Promise.resolve();
      }) as unknown as MockWorkspaceConfig["editConfig"],
    };

    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
  });

  afterEach(async () => {
    await fsPromises.rm(tempRoot, { recursive: true, force: true });
    await cleanupHistory();
  });

  test("remove() closes desktop sessions on success", async () => {
    let guard: ((workspaceId: string) => boolean) | undefined;
    const guardDuringClose: { value?: boolean } = {};
    const close = mock(() => {
      // Desktop startups consult this guard synchronously; a borrower bridge connecting between
      // the close and the awaited config deletion must be refused just like during archive.
      guardDuringClose.value = guard?.(workspaceId);
      return Promise.resolve(undefined);
    });
    const desktopSessionManager = {
      close,
      setWorkspaceArchiveGuard: (next: (workspaceId: string) => boolean) => {
        guard = next;
      },
    } as unknown as DesktopSessionManager;
    workspaceService.setDesktopSessionManager(desktopSessionManager);
    expect(guard?.(workspaceId)).toBe(false);

    const result = await workspaceService.remove(workspaceId);

    expect(result.success).toBe(true);
    expect(guardDuringClose.value).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(workspaceId);
  });

  test("remove() reopens the timeline when removal aborts with the workspace still configured", async () => {
    await fsPromises.mkdir(path.join(tempRoot, "sessions", workspaceId), { recursive: true });
    const reopened: string[] = [];
    workspaceService.setTimelineRecorder({
      record: () => undefined,
      closeWorkspace: () => Promise.resolve(),
      reopenWorkspace: (id) => reopened.push(id),
    });
    removeWorkspaceMock.mockImplementation(() => {
      throw new Error("config write failed");
    });

    const result = await workspaceService.remove(workspaceId);

    expect(result.success).toBe(false);
    expect(reopened).toEqual([workspaceId]);
  });

  test("remove() lifts the consolidation teardown gate only when it aborts before committing", async () => {
    const calls: string[] = [];
    workspaceService.setMemoryConsolidationService({
      triggerInBackground: () => undefined,
      triggerHarvestThenSweepInBackground: () => undefined,
      cancelInFlightConsolidation: () => {
        calls.push("cancel");
        return Promise.resolve();
      },
      releaseRemovalCancellation: () => {
        calls.push("release");
      },
      finalizeHarvestsForRemoval: () => {
        calls.push("finalize");
        return Promise.resolve();
      },
    });
    // Aborted before the point of no return (live descendant tasks): the
    // workspace stays intact, so any teardown gate is lifted again and no
    // harvest state is finalized.
    let descendants = true;
    workspaceService.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({ hasDescendantAgentTasks: () => descendants })
    );
    const aborted = await workspaceService.remove(workspaceId);
    expect(aborted.success).toBe(false);
    expect(calls).toEqual(["release"]);
    // Aborted inside the locked handover (a late legacy note the owner store
    // cannot take), i.e. after the drain but BEFORE the tombstone: the session
    // directory survives, so the gate is lifted too.
    descendants = false;
    calls.length = 0;
    const sessionDir = path.join(tempRoot, "sessions", workspaceId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    const topology = {
      projects: new Map([
        [
          "/tmp/src/project",
          {
            workspaces: [
              { path: "/tmp/src/project/owner", id: "ws-owner" },
              { path: "/tmp/src/project/child", id: workspaceId, parentWorkspaceId: "ws-owner" },
            ],
          },
        ],
      ]),
    };
    // The service holds its own copy of the mock config (createWorkspaceServiceForTest).
    const config = (workspaceService as unknown as { config: MockWorkspaceConfig }).config;
    const previousLoad = config.loadConfigOrDefault;
    config.loadConfigOrDefault = (() => topology) as MockWorkspaceConfig["loadConfigOrDefault"];
    workspaceService.setSharedWorkspaceMemoryStore({
      adoptLegacyPrivateStoreForRemoval: () =>
        Promise.reject(new Error("1 legacy note could not be folded into the shared notebook")),
    });
    try {
      const lockedAbort = await workspaceService.remove(workspaceId);
      expect(lockedAbort.success).toBe(false);
      if (!lockedAbort.success) expect(lockedAbort.error).toContain("tombstone could be published");
      expect(existsSync(sessionDir)).toBe(true);
      expect(calls).toContain("cancel");
      expect(calls).toContain("release");
      expect(calls).not.toContain("finalize");
    } finally {
      config.loadConfigOrDefault = previousLoad;
      workspaceService.setSharedWorkspaceMemoryStore({
        adoptLegacyPrivateStoreForRemoval: () => Promise.resolve(),
      });
    }
    // Committed removal: cancelled (drained), harvest records finalized once
    // the session directory is gone, and never released.
    calls.length = 0;
    const removed = await workspaceService.remove(workspaceId);
    expect(removed.success).toBe(true);
    expect(existsSync(sessionDir)).toBe(false);
    expect(calls.filter((call) => call === "cancel").length).toBeGreaterThan(0);
    expect(calls).toContain("finalize");
    expect(calls).not.toContain("release");
  });

  test("remove() succeeds and emits its removal event when finalizing harvest records fails", async () => {
    workspaceService.setMemoryConsolidationService({
      triggerInBackground: () => undefined,
      triggerHarvestThenSweepInBackground: () => undefined,
      cancelInFlightConsolidation: () => Promise.resolve(),
      releaseRemovalCancellation: () => undefined,
      finalizeHarvestsForRemoval: () => Promise.reject(new Error("sidecar unwritable")),
    });
    const removed: string[] = [];
    workspaceService.on("metadata", (event: { workspaceId: string; metadata: unknown }) => {
      if (event.metadata === null) removed.push(event.workspaceId);
    });
    const sessionDir = path.join(tempRoot, "sessions", workspaceId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    // Deregistration already committed: harvest bookkeeping is best-effort.
    const result = await workspaceService.remove(workspaceId);
    expect(result.success).toBe(true);
    expect(removeWorkspaceMock).toHaveBeenCalledWith(workspaceId);
    expect(removed).toEqual([workspaceId]);
    expect(existsSync(sessionDir)).toBe(false);
  });

  test("remove() flushes the timeline before deleting the session directory", async () => {
    const sessionDir = path.join(tempRoot, "sessions", workspaceId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    const order: string[] = [];
    workspaceService.setTimelineRecorder({
      record: () => undefined,
      closeWorkspace: () => {
        // A queued append recreates the session directory, so closing is only useful while the
        // directory still exists.
        order.push(existsSync(sessionDir) ? "closed-before-delete" : "closed-after-delete");
        return Promise.resolve();
      },
      reopenWorkspace: () => undefined,
    });

    const result = await workspaceService.remove(workspaceId);

    expect(result.success).toBe(true);
    expect(order).toEqual(["closed-before-delete"]);
    expect(existsSync(sessionDir)).toBe(false);
  });

  test("remove() continues when desktop session cleanup fails", async () => {
    const close = mock(() => Promise.reject(new Error("close failed")));
    const desktopSessionManager = {
      close,
      setWorkspaceArchiveGuard: () => undefined,
    } as unknown as DesktopSessionManager;
    workspaceService.setDesktopSessionManager(desktopSessionManager);

    const result = await workspaceService.remove(workspaceId);

    expect(result.success).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(workspaceId);
    expect(removeWorkspaceMock).toHaveBeenCalledWith(workspaceId);
  });
});

describe("WorkspaceService deleteWorktree", () => {
  const workspaceId = "ws-delete-worktree";
  const projectName = "proj";
  const projectPath = "/tmp/project";
  const workspaceName = "ws-delete-worktree";

  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let tempSrcBaseDir: string;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
    tempSrcBaseDir = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-delete-worktree-"));
  });

  afterEach(async () => {
    mock.restore();
    await cleanupHistory();
    await fsPromises.rm(tempSrcBaseDir, { recursive: true, force: true });
  });

  function createHarness(options?: {
    archivedAt?: string;
    runtimeConfig?: FrontendWorkspaceMetadata["runtimeConfig"];
    taskIsolation?: FrontendWorkspaceMetadata["taskIsolation"];
  }): {
    workspaceService: WorkspaceService;
    metadataEvents: Array<FrontendWorkspaceMetadata | null>;
    managedPath: string;
  } {
    const runtimeConfig = options?.runtimeConfig ?? {
      type: "worktree",
      srcBaseDir: tempSrcBaseDir,
    };
    const managedPath = path.join(tempSrcBaseDir, "_workspaces", workspaceName);

    const getCurrentMetadata = async (): Promise<FrontendWorkspaceMetadata> => {
      const transcriptOnly = await fsPromises
        .access(managedPath)
        .then(() => false)
        .catch(() => true);

      return {
        id: workspaceId,
        name: workspaceName,
        projectName,
        projectPath,
        runtimeConfig,
        archivedAt: options?.archivedAt,
        taskIsolation: options?.taskIsolation,
        transcriptOnly,
        namedWorkspacePath: managedPath,
      };
    };

    const mockConfig: MockWorkspaceConfig = {
      srcDir: tempSrcBaseDir,
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      getAllWorkspaceMetadata: mock(async () => [await getCurrentMetadata()]),
    };

    const aiService = {
      ...createStreamLifecycleMocks(),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    const workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });

    const metadataEvents: Array<FrontendWorkspaceMetadata | null> = [];
    workspaceService.on("metadata", (event: unknown) => {
      if (!event || typeof event !== "object") {
        return;
      }
      const parsed = event as { workspaceId: string; metadata: FrontendWorkspaceMetadata | null };
      if (parsed.workspaceId === workspaceId) {
        metadataEvents.push(parsed.metadata);
      }
    });

    return { workspaceService, metadataEvents, managedPath };
  }

  test("deletes an archived managed worktree and emits transcript-only metadata", async () => {
    const { workspaceService, metadataEvents, managedPath } = createHarness({
      archivedAt: "2026-03-01T00:00:00.000Z",
    });
    await fsPromises.mkdir(managedPath, { recursive: true });
    const removeManagedGitWorktreeSpy = spyOn(
      removeManagedGitWorktreeModule,
      "removeManagedGitWorktree"
    ).mockImplementation(async (_projectPath, worktreePath) => {
      await fsPromises.rm(worktreePath, { recursive: true, force: true });
    });

    const result = await workspaceService.deleteWorktree(workspaceId);

    expect(result).toEqual(Ok(undefined));
    expect(removeManagedGitWorktreeSpy).toHaveBeenCalledWith(projectPath, managedPath);
    expect(
      await fsPromises
        .access(managedPath)
        .then(() => true)
        .catch(() => false)
    ).toBe(false);
    expect(metadataEvents.at(-1)?.transcriptOnly).toBe(true);
  });

  test("returns success when the managed worktree is already missing", async () => {
    const { workspaceService, metadataEvents, managedPath } = createHarness({
      archivedAt: "2026-03-01T00:00:00.000Z",
    });
    const removeManagedGitWorktreeSpy = spyOn(
      removeManagedGitWorktreeModule,
      "removeManagedGitWorktree"
    ).mockResolvedValue(undefined);

    const result = await workspaceService.deleteWorktree(workspaceId);

    expect(result).toEqual(Ok(undefined));
    expect(removeManagedGitWorktreeSpy).toHaveBeenCalledWith(projectPath, managedPath);
    expect(metadataEvents.at(-1)?.transcriptOnly).toBe(true);
  });

  test("rejects deleting a worktree for a non-archived workspace", async () => {
    const { workspaceService, managedPath } = createHarness({
      archivedAt: undefined,
    });
    await fsPromises.mkdir(managedPath, { recursive: true });

    const result = await workspaceService.deleteWorktree(workspaceId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("Only archived workspaces can delete their managed worktree");
    }
    expect(
      await fsPromises
        .access(managedPath)
        .then(() => true)
        .catch(() => false)
    ).toBe(true);
  });

  test("rejects deleting the shared checkout for an isolation-none sub-agent", async () => {
    const { workspaceService, managedPath } = createHarness({
      archivedAt: "2026-03-01T00:00:00.000Z",
      taskIsolation: "none",
    });
    await fsPromises.mkdir(managedPath, { recursive: true });
    const removeManagedGitWorktreeSpy = spyOn(
      removeManagedGitWorktreeModule,
      "removeManagedGitWorktree"
    );

    const result = await workspaceService.deleteWorktree(workspaceId);

    expect(result).toEqual(Err("Shared-checkout sub-agents do not own a managed worktree"));
    expect(removeManagedGitWorktreeSpy).not.toHaveBeenCalled();
  });

  test("rejects deleting a worktree for non-worktree runtimes", async () => {
    const { workspaceService } = createHarness({
      archivedAt: "2026-03-01T00:00:00.000Z",
      runtimeConfig: { type: "local" },
    });

    const result = await workspaceService.deleteWorktree(workspaceId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe(
        "Deleting a managed worktree is only supported for worktree runtimes"
      );
    }
  });
});

describe("WorkspaceService.remove usage-rollup ordering", () => {
  test("usage recorded while draining background producers reaches the parent rollup", async () => {
    // Codex round 13: the child's usage snapshot was read BEFORE the
    // cancel-and-drain calls for the pending branch summary and in-flight
    // /refine pass. A draining producer records headless usage as it
    // settles, so that spend landed after the snapshot and was permanently
    // lost from parent accounting (the child is deleted with no second
    // rollup). Drains must complete before the snapshot is read.
    const { config, historyService, cleanup } = await createTestHistoryService();
    const projectDir = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-rollup-"));
    const parentId = "rollup-parent-ws";
    const childId = "rollup-child-ws";
    try {
      await config.editConfig((cfg) => {
        cfg.projects.set(projectDir, {
          trusted: true,
          workspaces: [
            { path: projectDir, id: parentId, name: parentId },
            { path: projectDir, id: childId, name: childId, parentWorkspaceId: parentId },
          ],
        });
        return cfg;
      });

      // Fake usage ledger: the draining refine pass records the child's
      // spend only when cancelInFlightRefinePass runs (modelling a settle-
      // time recordHeadlessUsage write).
      const usageByWorkspace = new Map<string, Record<string, unknown>>();
      const rollupCalls: Array<{ parent: string; child: string; byModel: object }> = [];
      const sessionUsageService = {
        getSessionUsage: (workspaceId: string) =>
          Promise.resolve({ byModel: usageByWorkspace.get(workspaceId) ?? {} }),
        rollUpUsageIntoParent: (parent: string, child: string, byModel: object) => {
          rollupCalls.push({ parent, child, byModel });
          return Promise.resolve({ didRollUp: true });
        },
      } as unknown as SessionUsageService;
      const cancelInFlightRefinePass = mock((workspaceId: string) => {
        // The drained pass settles and records its spend against the child.
        usageByWorkspace.set(workspaceId, {
          "anthropic:claude-sonnet-4-5": { input: { tokens: 42, cost_usd: 0.01 } },
        });
        return Promise.resolve();
      });

      const service = createWorkspaceServiceForTest({
        config,
        historyService,
        sessionUsageService,
        aiService: createMockAIService({
          getWorkspaceMetadata: (async (workspaceId: string) => {
            const metadata = (await config.getAllWorkspaceMetadata()).find(
              (m) => m.id === workspaceId
            );
            return metadata ? Ok(metadata) : Err("workspace not found");
          }) as AIService["getWorkspaceMetadata"],
        }),
      });
      service.setRefinePassCanceller({ cancelInFlightRefinePass });

      const result = await service.remove(childId);
      expect(result.success).toBe(true);
      expect(cancelInFlightRefinePass).toHaveBeenCalled();

      // The drain-recorded spend made it into the parent rollup snapshot.
      expect(rollupCalls).toHaveLength(1);
      expect(rollupCalls[0].parent).toBe(parentId);
      expect(rollupCalls[0].child).toBe(childId);
      expect(Object.keys(rollupCalls[0].byModel)).toContain("anthropic:claude-sonnet-4-5");
    } finally {
      await fsPromises.rm(projectDir, { recursive: true, force: true });
      await cleanup();
    }
  });

  test("a failed non-forced deletion defers the one-shot rollups until removal commits", async () => {
    // rollUpUsageIntoParent / rollUpTimingIntoParent record the child in the
    // one-shot rolledUpFrom guard. Rolling up BEFORE runtime deletion meant a
    // force=false deletion failure left the child usable, and the eventual
    // successful removal skipped the rollup — permanently losing the child's
    // post-failure spend from parent accounting. Rollups must run only after
    // deletion can no longer fail, so a failed attempt rolls up nothing and
    // the retry captures the child's full (including post-failure) usage.
    const { config, historyService, cleanup } = await createTestHistoryService();
    const projectDir = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-rollup-retry-"));
    const parentId = "rollup-retry-parent-ws";
    const childId = "rollup-retry-child-ws";
    let deletionFails = true;
    const deleteWorkspaceMock = mock(() =>
      deletionFails
        ? Promise.resolve({ success: false as const, error: "worktree has uncommitted changes" })
        : Promise.resolve({ success: true as const, deletedPath: projectDir })
    );
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace: deleteWorkspaceMock,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
    try {
      await config.editConfig((cfg) => {
        cfg.projects.set(projectDir, {
          trusted: true,
          workspaces: [
            { path: projectDir, id: parentId, name: parentId },
            { path: projectDir, id: childId, name: childId, parentWorkspaceId: parentId },
          ],
        });
        return cfg;
      });

      const childUsage: Record<string, unknown> = {
        "anthropic:claude-sonnet-4-5": { input: { tokens: 42, cost_usd: 0.01 } },
      };
      const usageRollups: Array<{ parent: string; child: string; byModel: object }> = [];
      const sessionUsageService = {
        getSessionUsage: () => Promise.resolve({ byModel: { ...childUsage } }),
        rollUpUsageIntoParent: (parent: string, child: string, byModel: object) => {
          usageRollups.push({ parent, child, byModel });
          return Promise.resolve({ didRollUp: true });
        },
      } as unknown as SessionUsageService;
      const timingRollups: string[] = [];
      const sessionTimingService = {
        waitForIdle: () => Promise.resolve(),
        rollUpTimingIntoParent: (_parent: string, child: string) => {
          timingRollups.push(child);
          return Promise.resolve();
        },
      } as unknown as SessionTimingService;

      const service = createWorkspaceServiceForTest({
        config,
        historyService,
        sessionUsageService,
        sessionTimingService,
        aiService: createMockAIService({
          getWorkspaceMetadata: (async (workspaceId: string) => {
            const metadata = (await config.getAllWorkspaceMetadata()).find(
              (m) => m.id === workspaceId
            );
            return metadata ? Ok(metadata) : Err("workspace not found");
          }) as AIService["getWorkspaceMetadata"],
        }),
      });

      // Non-forced removal fails at runtime deletion: the child stays usable,
      // so neither one-shot rollup may have been consumed.
      const failedAttempt = await service.remove(childId);
      expect(failedAttempt.success).toBe(false);
      expect(deleteWorkspaceMock).toHaveBeenCalledTimes(1);
      expect(usageRollups).toHaveLength(0);
      expect(timingRollups).toHaveLength(0);

      // The still-usable child accrues more spend before the retry.
      childUsage["openai:gpt-5.2"] = { input: { tokens: 7, cost_usd: 0.002 } };

      deletionFails = false;
      const retry = await service.remove(childId);
      expect(retry.success).toBe(true);

      // The retry rolls up exactly once, with the full post-failure snapshot.
      expect(timingRollups).toEqual([childId]);
      expect(usageRollups).toHaveLength(1);
      expect(usageRollups[0].parent).toBe(parentId);
      expect(usageRollups[0].child).toBe(childId);
      expect(Object.keys(usageRollups[0].byModel)).toEqual([
        "anthropic:claude-sonnet-4-5",
        "openai:gpt-5.2",
      ]);
    } finally {
      createRuntimeSpy.mockRestore();
      await fsPromises.rm(projectDir, { recursive: true, force: true });
      await cleanup();
    }
  });
});

describe("WorkspaceService.remove checkout-deletion ordering", () => {
  test("an admitted apply's checkout write completes before removal deletes the workdir", async () => {
    // Codex round 15: the refine drain ran AFTER runtime/workdir deletion, so
    // an admitted /refine apply's agent_skill_write could race checkout
    // deletion — recreating .mux/skills inside the deleted tree (orphaned
    // state) or failing midway with the failure swallowed. The drain must
    // complete before any disk mutation.
    const { config, historyService, cleanup } = await createTestHistoryService();
    const scratchId = "scratch-apply-race";
    const scratchDir = path.join(config.rootDir, "scratch", scratchId);
    try {
      await fsPromises.mkdir(scratchDir, { recursive: true });
      await config.editConfig((cfg) => {
        cfg.projects.set(SCRATCH_PROJECT_CONFIG_KEY, {
          workspaces: [{ path: scratchDir, id: scratchId, name: scratchId, kind: "scratch" }],
        });
        return cfg;
      });
      const scratchMetadata: WorkspaceMetadata = {
        id: scratchId,
        name: scratchId,
        projectName: "scratch",
        projectPath: scratchDir,
        runtimeConfig: { type: "local" },
        kind: "scratch",
      };
      // Models the admitted apply completing during the drain: it writes a
      // project skill into the CHECKOUT as it settles. Only the FIRST drain
      // has an in-flight pass (matching the real idempotent canceller — later
      // calls find nothing to drain and no-op).
      let drained = false;
      const cancelInFlightRefinePass = mock(async () => {
        if (drained) return;
        drained = true;
        await fsPromises.mkdir(path.join(scratchDir, ".mux", "skills", "lesson"), {
          recursive: true,
        });
        await fsPromises.writeFile(
          path.join(scratchDir, ".mux", "skills", "lesson", "SKILL.md"),
          "distilled\n"
        );
      });
      const service = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          getWorkspaceMetadata: (() =>
            Promise.resolve(Ok(scratchMetadata))) as AIService["getWorkspaceMetadata"],
        }),
      });
      service.setRefinePassCanceller({ cancelInFlightRefinePass });

      const result = await service.remove(scratchId);
      expect(result.success).toBe(true);
      expect(cancelInFlightRefinePass).toHaveBeenCalled();

      // The drain's checkout write happened BEFORE workdir deletion, so the
      // removal deleted everything — no recreated .mux/skills orphan.
      const workdirExists = await fsPromises.access(scratchDir).then(
        () => true,
        () => false
      );
      expect(workdirExists).toBe(false);
    } finally {
      await fsPromises.rm(scratchDir, { recursive: true, force: true });
      await cleanup();
    }
  });
});
