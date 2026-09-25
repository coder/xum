import { describe, expect, test, mock, beforeEach, afterEach, spyOn } from "bun:test";
import type { WorkspaceService } from "./workspaceService";
import { EventEmitter } from "events";
import { existsSync } from "fs";
import * as fsPromises from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { Err, Ok, type Result } from "@/common/types/result";
import { SCRATCH_PROJECT_CONFIG_KEY } from "@/common/constants/scratch";
import type { Config } from "@/node/config";
import { createTestProject, projectWorkspace, saveWorkspaces } from "./taskService.testHarness";
import type { SessionTimingService } from "./sessionTimingService";
import type { SessionUsageService } from "./sessionUsageService";
import type { AIService } from "./aiService";
import type { FrontendWorkspaceMetadata, WorkspaceMetadata } from "@/common/types/workspace";
import { makeAgentTaskIntegrationFake } from "./taskWorkspaceSeam.testUtils";
import { resolveWorkspaceMemoryOwnerId } from "./memoryWorkspaceOwner";
import { isWorkspaceRemovalTombstoned } from "./workspaceRemoval";
import { MemoryService } from "./memoryService";
import { MemoryMetaService } from "./memoryMeta";
import type { DesktopSessionManager } from "@/node/services/desktop/DesktopSessionManager";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import * as removeManagedGitWorktreeModule from "@/node/worktree/removeManagedGitWorktree";
import type {
  WorkspaceServiceHarness,
  WorkspaceServiceHarnessOptions,
} from "./workspaceService.testHarness";
import { createMockAIService, createWorkspaceServiceHarness } from "./workspaceService.testHarness";

/** Real-dependency harness whose AI fake answers workspace metadata from the real config. */
async function createHarness(
  options: WorkspaceServiceHarnessOptions = {}
): Promise<WorkspaceServiceHarness> {
  const harness = await createWorkspaceServiceHarness(options);
  spyOn(harness.aiService, "getWorkspaceMetadata").mockImplementation(
    async (workspaceId: string) => {
      const metadata = await harness.config.getWorkspaceMetadataById(workspaceId);
      return metadata ? Ok(metadata) : Err(`Workspace metadata not found for ${workspaceId}`);
    }
  );
  return harness;
}

function sessionDirOf(config: Config, workspaceId: string): string {
  return path.join(config.sessionsDir, workspaceId);
}

describe("WorkspaceService remove lifecycle coordination", () => {
  test("acknowledged removal keeps the parent last and returns forced failure scope", async () => {
    await using harness = await createWorkspaceServiceHarness();
    const { config, service: workspaceService } = harness;
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
  });

  test("checks descendant tasks while holding the task-tree lifecycle lock", async () => {
    const workspaceId = "parent-remove-lifecycle";
    await using harness = await createWorkspaceServiceHarness();
    const workspaceService = harness.service;
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
  test("waits for stream-abort before rolling up session timing", async () => {
    const workspaceId = "child-ws";
    const parentWorkspaceId = "parent-ws";
    const projectPath = "/tmp/proj";

    const stopEntered = Promise.withResolvers<void>();
    const stopRelease = Promise.withResolvers<void>();
    let abortEmitted = false;
    let rollUpSawAbort = false;

    const aiEmitter = new EventEmitter();
    const aiService = createMockAIService({
      on: aiEmitter.on.bind(aiEmitter) as unknown as AIService["on"],
      off: aiEmitter.off.bind(aiEmitter) as unknown as AIService["off"],
      isStreaming: mock(() => true),
      stopStream: mock(async () => {
        stopEntered.resolve();
        await stopRelease.promise;
        abortEmitted = true;
        aiEmitter.emit("stream-abort", {
          type: "stream-abort",
          workspaceId,
          messageId: "msg",
          abortReason: "system",
          metadata: { duration: 123 },
          abandonPartial: true,
        });
        return Ok(undefined);
      }),
    });

    const timingService: Partial<SessionTimingService> = {
      waitForIdle: mock(() => Promise.resolve()),
      rollUpTimingIntoParent: mock(() => {
        rollUpSawAbort = abortEmitted;
        return Promise.resolve({ didRollUp: true });
      }),
    };

    await using harness = await createHarness({
      aiService,
      sessionTimingService: timingService as SessionTimingService,
    });
    const { config, service: workspaceService, initStateManager } = harness;
    await saveWorkspaces(config, projectPath, [
      projectWorkspace(projectPath, "parent", parentWorkspaceId, {
        runtimeConfig: { type: "local" },
      }),
      projectWorkspace(projectPath, "child", workspaceId, {
        runtimeConfig: { type: "local" },
        parentWorkspaceId,
      }),
    ]);
    await fsPromises.mkdir(sessionDirOf(config, workspaceId), { recursive: true });
    const clearInMemoryState = spyOn(initStateManager, "clearInMemoryState");

    try {
      const removing = workspaceService.remove(workspaceId, true);
      await stopEntered.promise;
      expect(timingService.rollUpTimingIntoParent).not.toHaveBeenCalled();
      stopRelease.resolve();
      const removeResult = await removing;
      expect(removeResult.success).toBe(true);
      expect(clearInMemoryState).toHaveBeenCalledWith(workspaceId);
      expect(rollUpSawAbort).toBe(true);
    } finally {
      stopRelease.resolve();
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

  async function createHandoverHarness(): Promise<WorkspaceServiceHarness> {
    const harness = await createHarness();
    await saveWorkspaces(harness.config, projectPath, [
      projectWorkspace(projectPath, "owner-ws", ownerId, { name: "owner", runtimeConfig }),
      projectWorkspace(projectPath, "child-ws", workspaceId, {
        name: "child",
        runtimeConfig,
        parentWorkspaceId: ownerId,
      }),
    ]);
    await fsPromises.mkdir(sessionDirOf(harness.config, workspaceId), { recursive: true });
    return harness;
  }

  test("a handover the owner cannot take aborts before the checkout is deleted", async () => {
    const deleteWorkspace = mock(() =>
      Promise.resolve({ success: true as const, deletedPath: workspacePath })
    );
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
    await using harness = await createHandoverHarness();
    const { config, service: workspaceService } = harness;
    try {
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
      expect(existsSync(sessionDirOf(config, workspaceId))).toBe(true);
      expect(await isWorkspaceRemovalTombstoned(config.rootDir, workspaceId)).toBe(false);
      // force accepts the loss and completes the removal.
      expect((await workspaceService.remove(workspaceId, true)).success).toBe(true);
      expect(deleteWorkspace).toHaveBeenCalledTimes(1);
      expect(existsSync(sessionDirOf(config, workspaceId))).toBe(false);
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
    await using harness = await createHandoverHarness();
    const { config, service: workspaceService } = harness;
    try {
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
      expect(config.findWorkspace(workspaceId)).not.toBeNull();
      expect(await isWorkspaceRemovalTombstoned(config.rootDir, workspaceId)).toBe(false);
      expect(existsSync(sessionDirOf(config, workspaceId))).toBe(true);
      expect(calls).toContain("release");
      expect(calls).not.toContain("finalize");
      // The child's memory works again: its shared-store write is not
      // refused by a stale tombstone.
      const memoryService = new MemoryService(config, new MemoryMetaService(config.rootDir));
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
      expect(await isWorkspaceRemovalTombstoned(config.rootDir, workspaceId)).toBe(true);
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
    await using harness = await createHandoverHarness();
    const { config, service: workspaceService } = harness;
    try {
      let sealedTombstone = false;
      workspaceService.setSharedWorkspaceMemoryStore({
        adoptLegacyPrivateStoreForRemoval: () => Promise.resolve(),
      });
      deleteWorkspace.mockImplementation(async () => {
        // Runtime deletion runs with the tombstone already sealed.
        sealedTombstone = await isWorkspaceRemovalTombstoned(config.rootDir, workspaceId);
        return refuse
          ? { success: false as const, error: "Workspace has uncommitted changes" }
          : { success: true as const, deletedPath: workspacePath };
      });
      const refused = await workspaceService.remove(workspaceId);
      expect(refused.success).toBe(false);
      if (!refused.success) expect(refused.error).toContain("uncommitted changes");
      expect(sealedTombstone).toBe(true);
      expect(await isWorkspaceRemovalTombstoned(config.rootDir, workspaceId)).toBe(false);
      expect(existsSync(sessionDirOf(config, workspaceId))).toBe(true);
      refuse = false;
      expect((await workspaceService.remove(workspaceId)).success).toBe(true);
      expect(await isWorkspaceRemovalTombstoned(config.rootDir, workspaceId)).toBe(true);
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

  async function createChildHarness(
    taskIsolation?: "none" | "fork"
  ): Promise<WorkspaceServiceHarness> {
    const harness = await createHarness();
    await saveWorkspaces(harness.config, projectPath, [
      projectWorkspace(projectPath, "parent-ws", workspaceId, {
        name: "agent_explore_child",
        runtimeConfig,
        taskIsolation,
      }),
    ]);
    return harness;
  }

  function mockDeleteWorkspace() {
    const deleteWorkspace = mock(() =>
      Promise.resolve({ success: true as const, deletedPath: sharedPath })
    );
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
    return { deleteWorkspace, createRuntimeSpy };
  }

  test("does not delete the shared parent checkout for isolation: none tasks", async () => {
    const { deleteWorkspace, createRuntimeSpy } = mockDeleteWorkspace();
    try {
      await using harness = await createChildHarness("none");

      const result = await harness.service.remove(workspaceId, true);
      expect(result.success).toBe(true);
      // The parent's checkout must never be physically deleted on behalf of a shared task.
      expect(deleteWorkspace).not.toHaveBeenCalled();
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });

  test("deletes the workspace for normal (forked) tasks", async () => {
    const { deleteWorkspace, createRuntimeSpy } = mockDeleteWorkspace();
    try {
      await using harness = await createChildHarness(undefined);

      const result = await harness.service.remove(workspaceId, true);
      expect(result.success).toBe(true);
      expect(deleteWorkspace).toHaveBeenCalledTimes(1);
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });

  // Inverse direction: removing the PARENT while a live shared child points at its checkout.
  async function createParentHarness(
    childTaskStatus: "running" | "queued" | "reported"
  ): Promise<WorkspaceServiceHarness> {
    const harness = await createHarness();
    await saveWorkspaces(harness.config, projectPath, [
      projectWorkspace(projectPath, "parent-ws", "parent-ws-id", { runtimeConfig }),
      projectWorkspace(projectPath, "parent-ws", workspaceId, {
        name: "agent_explore_child",
        runtimeConfig,
        parentWorkspaceId: "parent-ws-id",
        taskIsolation: "none",
        taskStatus: childTaskStatus,
      }),
    ]);
    return harness;
  }

  test("does not delete a parent checkout shared by an active isolation: none child", async () => {
    const { deleteWorkspace, createRuntimeSpy } = mockDeleteWorkspace();
    try {
      await using harness = await createParentHarness("running");

      const result = await harness.service.remove("parent-ws-id", true);
      expect(result.success).toBe(true);
      // The running shared child still uses this checkout as its cwd.
      expect(deleteWorkspace).not.toHaveBeenCalled();
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });

  test("deletes a parent checkout when its shared child is only queued (fails fast at dequeue like forked tasks)", async () => {
    const { deleteWorkspace, createRuntimeSpy } = mockDeleteWorkspace();
    try {
      await using harness = await createParentHarness("queued");

      const result = await harness.service.remove("parent-ws-id", true);
      expect(result.success).toBe(true);
      // Queued children require the parent config entry to launch regardless of isolation, so
      // they fail fast at dequeue either way — preserving the checkout would only leak it.
      expect(deleteWorkspace).toHaveBeenCalledTimes(1);
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });

  test("deletes a parent checkout when its shared child already reported", async () => {
    const { deleteWorkspace, createRuntimeSpy } = mockDeleteWorkspace();
    try {
      await using harness = await createParentHarness("reported");

      const result = await harness.service.remove("parent-ws-id", true);
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
  let harness: WorkspaceServiceHarness;
  let config: Config;
  let workspaceService: WorkspaceService;
  let projectPath: string;
  let ownerPath: string;

  beforeEach(async () => {
    harness = await createHarness();
    ({ config, service: workspaceService } = harness);
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
  });

  afterEach(async () => {
    await harness.cleanup();
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

  /** owner → mid → grand: removing `mid` must keep `grand` on the owner's notebook. */
  async function createPinHarness(options: {
    persistPins: boolean;
  }): Promise<WorkspaceServiceHarness> {
    const harness = await createHarness();
    const { config } = harness;
    await saveWorkspaces(config, projectPath, [
      projectWorkspace(projectPath, "owner", "ws-owner", { runtimeConfig }),
      projectWorkspace(projectPath, "mid", "ws-mid", {
        runtimeConfig,
        parentWorkspaceId: "ws-owner",
      }),
      projectWorkspace(projectPath, "grand", "ws-grand", {
        runtimeConfig,
        parentWorkspaceId: "ws-mid",
      }),
    ]);
    if (!options.persistPins) {
      // Config swallows write failures: a pin that does not land must be
      // caught by the removal's verified read-back, so the no-persist variant
      // drops every memory-owner pin from the edits it writes.
      const editConfig = config.editConfig.bind(config);
      spyOn(config, "editConfig").mockImplementation((edit, editOptions) =>
        editConfig((cfg) => {
          const next = edit(cfg);
          for (const project of next.projects.values()) {
            for (const workspace of project.workspaces) delete workspace.memoryOwnerWorkspaceId;
          }
          return next;
        }, editOptions)
      );
    }
    return harness;
  }

  function findEntry(config: Config, workspaceId: string) {
    return config
      .loadConfigOrDefault()
      .projects.get(projectPath)
      ?.workspaces.find((ws) => ws.id === workspaceId);
  }

  function mockDeleteWorkspace() {
    const deleteWorkspace = mock(() =>
      Promise.resolve({ success: true as const, deletedPath: `${projectPath}/mid` })
    );
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
    return { deleteWorkspace, createRuntimeSpy };
  }

  test("pins surviving descendants to the root owner before tearing the middle node down", async () => {
    const { deleteWorkspace, createRuntimeSpy } = mockDeleteWorkspace();
    try {
      await using harness = await createPinHarness({ persistPins: true });
      const { config } = harness;
      const result = await harness.service.remove("ws-mid");
      expect(result.success).toBe(true);
      expect(deleteWorkspace).toHaveBeenCalledTimes(1);
      expect(findEntry(config, "ws-grand")?.memoryOwnerWorkspaceId).toBe("ws-owner");
      // Once ws-mid is gone the pin keeps ws-grand on the root's notebook.
      expect(findEntry(config, "ws-mid")).toBeUndefined();
      expect(resolveWorkspaceMemoryOwnerId(config.loadConfigOrDefault(), "ws-grand")).toBe(
        "ws-owner"
      );
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });

  test("aborts a non-forced removal (workspace intact) when the descendant pin does not persist", async () => {
    const { deleteWorkspace, createRuntimeSpy } = mockDeleteWorkspace();
    try {
      await using harness = await createPinHarness({ persistPins: false });
      const refused = await harness.service.remove("ws-mid");
      expect(refused.success).toBe(false);
      if (!refused.success) expect(refused.error).toContain("retry the removal");
      // Nothing destructive ran: no checkout deletion, no deregistration.
      expect(deleteWorkspace).not.toHaveBeenCalled();
      expect(findEntry(harness.config, "ws-mid")).toBeDefined();

      // Forced removal accepts the loss and proceeds.
      const forced = await harness.service.remove("ws-mid", true);
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
    const { deleteWorkspace, createRuntimeSpy } = mockDeleteWorkspace();
    try {
      await using harness = await createPinHarness({ persistPins: true });
      const { config, aiService } = harness;
      // The workspace metadata was built before config.json became unreadable.
      const midMetadata = await config.getWorkspaceMetadataById("ws-mid");
      if (midMetadata == null) throw new Error("ws-mid metadata is missing");
      spyOn(aiService, "getWorkspaceMetadata").mockResolvedValue(Ok(midMetadata));
      const loadConfigOrDefault = spyOn(config, "loadConfigOrDefault").mockImplementation(
        (options?: { throwOnError?: boolean }) => {
          if (options?.throwOnError === true) throw new Error("config.json unreadable (EIO)");
          return { projects: new Map() };
        }
      );
      const editConfig = spyOn(config, "editConfig");
      const removeWorkspace = spyOn(config, "removeWorkspace");
      try {
        const refused = await harness.service.remove("ws-mid");
        expect(refused.success).toBe(false);
        if (!refused.success) {
          expect(refused.error).toContain("config.json unreadable");
          expect(refused.error).toContain("retry the removal");
        }
        expect(deleteWorkspace).not.toHaveBeenCalled();
        expect(removeWorkspace).not.toHaveBeenCalled();
        expect(editConfig).not.toHaveBeenCalled();

        // Forced removal accepts the loss and proceeds.
        const forced = await harness.service.remove("ws-mid", true);
        expect(forced.success).toBe(true);
        expect(deleteWorkspace).toHaveBeenCalledTimes(1);
      } finally {
        loadConfigOrDefault.mockRestore();
      }
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });

  test("pins surviving descendants even when the removed node's metadata cannot be built", async () => {
    // The phantom-cleanup path: no metadata, yet the config entry is removed
    // all the same — the pin is a config-only edit and must still land, or a
    // surviving child silently falls back to a private notebook.
    await using harness = await createPinHarness({ persistPins: true });
    spyOn(harness.aiService, "getWorkspaceMetadata").mockResolvedValue(Err("metadata unavailable"));
    const result = await harness.service.remove("ws-mid");
    expect(result.success).toBe(true);
    expect(findEntry(harness.config, "ws-mid")).toBeUndefined();
    expect(findEntry(harness.config, "ws-grand")?.memoryOwnerWorkspaceId).toBe("ws-owner");

    // ...and a pin that does not persist still aborts the non-forced removal
    // on that path, before the config entry is dropped.
    await using unpersisted = await createPinHarness({ persistPins: false });
    spyOn(unpersisted.aiService, "getWorkspaceMetadata").mockResolvedValue(
      Err("metadata unavailable")
    );
    const refused = await unpersisted.service.remove("ws-mid");
    expect(refused.success).toBe(false);
    expect(findEntry(unpersisted.config, "ws-mid")).toBeDefined();
  });
});

describe("WorkspaceService remove desktop session cleanup", () => {
  const workspaceId = "ws-remove-desktop";

  let harness: WorkspaceServiceHarness;
  let config: Config;
  let workspaceService: WorkspaceService;
  let projectPath: string;

  beforeEach(async () => {
    // Default AI fake: no workspace metadata, so removal takes the phantom-cleanup path.
    harness = await createWorkspaceServiceHarness();
    ({ config, service: workspaceService } = harness);
    projectPath = path.join(harness.rootDir, "project");
    await saveWorkspaces(config, projectPath, [
      projectWorkspace(projectPath, "child", workspaceId, { runtimeConfig: { type: "local" } }),
    ]);
  });

  afterEach(async () => {
    await harness.cleanup();
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
    await fsPromises.mkdir(sessionDirOf(config, workspaceId), { recursive: true });
    const reopened: string[] = [];
    workspaceService.setTimelineRecorder({
      record: () => undefined,
      closeWorkspace: () => Promise.resolve(),
      reopenWorkspace: (id) => reopened.push(id),
    });
    spyOn(config, "removeWorkspace").mockRejectedValueOnce(new Error("config write failed"));

    const result = await workspaceService.remove(workspaceId);

    expect(result.success).toBe(false);
    expect(reopened).toEqual([workspaceId]);
    expect(config.findWorkspace(workspaceId)).not.toBeNull();
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
    const sessionDir = sessionDirOf(config, workspaceId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    const setOwner = (owned: boolean) =>
      saveWorkspaces(config, projectPath, [
        ...(owned ? [projectWorkspace(projectPath, "owner", "ws-owner")] : []),
        projectWorkspace(projectPath, "child", workspaceId, {
          runtimeConfig: { type: "local" },
          parentWorkspaceId: owned ? "ws-owner" : undefined,
        }),
      ]);
    await setOwner(true);
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
      await setOwner(false);
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
    const sessionDir = sessionDirOf(config, workspaceId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    // Deregistration already committed: harvest bookkeeping is best-effort.
    const result = await workspaceService.remove(workspaceId);
    expect(result.success).toBe(true);
    expect(config.findWorkspace(workspaceId)).toBeNull();
    expect(removed).toEqual([workspaceId]);
    expect(existsSync(sessionDir)).toBe(false);
  });

  test("remove() flushes the timeline before deleting the session directory", async () => {
    const sessionDir = sessionDirOf(config, workspaceId);
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
    expect(config.findWorkspace(workspaceId)).toBeNull();
  });
});

describe("WorkspaceService deleteWorktree", () => {
  const workspaceId = "ws-delete-worktree";
  const projectPath = "/tmp/project";
  const workspaceName = "ws-delete-worktree";

  let harness: WorkspaceServiceHarness;
  let tempSrcBaseDir: string;

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness();
    tempSrcBaseDir = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-delete-worktree-"));
  });

  afterEach(async () => {
    mock.restore();
    await harness.cleanup();
    await fsPromises.rm(tempSrcBaseDir, { recursive: true, force: true });
  });

  async function setUpWorkspace(options?: {
    archivedAt?: string;
    runtimeConfig?: FrontendWorkspaceMetadata["runtimeConfig"];
    taskIsolation?: FrontendWorkspaceMetadata["taskIsolation"];
  }): Promise<{
    workspaceService: WorkspaceService;
    metadataEvents: Array<FrontendWorkspaceMetadata | null>;
    managedPath: string;
  }> {
    const runtimeConfig = options?.runtimeConfig ?? {
      type: "worktree",
      srcBaseDir: tempSrcBaseDir,
    };
    const managedPath = path.join(tempSrcBaseDir, "_workspaces", workspaceName);
    // The real config probes the checkout, so a missing managedPath reads as transcript-only.
    await saveWorkspaces(harness.config, projectPath, [
      {
        id: workspaceId,
        name: workspaceName,
        path: managedPath,
        runtimeConfig,
        archivedAt: options?.archivedAt,
        taskIsolation: options?.taskIsolation,
      },
    ]);

    const workspaceService = harness.service;
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
    const { workspaceService, metadataEvents, managedPath } = await setUpWorkspace({
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
    const { workspaceService, metadataEvents, managedPath } = await setUpWorkspace({
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
    const { workspaceService, managedPath } = await setUpWorkspace({
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
    const { workspaceService, managedPath } = await setUpWorkspace({
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
    const { workspaceService } = await setUpWorkspace({
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
    const projectDir = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-rollup-"));
    const parentId = "rollup-parent-ws";
    const childId = "rollup-child-ws";
    try {
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

      await using harness = await createHarness({ sessionUsageService });
      const { config, service } = harness;
      await saveWorkspaces(config, projectDir, [
        { path: projectDir, id: parentId, name: parentId },
        { path: projectDir, id: childId, name: childId, parentWorkspaceId: parentId },
      ]);
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

      await using harness = await createHarness({ sessionUsageService, sessionTimingService });
      const { config, service } = harness;
      await saveWorkspaces(config, projectDir, [
        { path: projectDir, id: parentId, name: parentId },
        { path: projectDir, id: childId, name: childId, parentWorkspaceId: parentId },
      ]);

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
    await using harness = await createWorkspaceServiceHarness();
    const { config, service, aiService } = harness;
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
      spyOn(aiService, "getWorkspaceMetadata").mockResolvedValue(Ok(scratchMetadata));
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
    }
  });
});
