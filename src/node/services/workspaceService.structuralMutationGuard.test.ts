import { afterEach, beforeEach, describe, expect, mock, spyOn, test, type Mock } from "bun:test";
import { EventEmitter } from "events";
import * as fsPromises from "fs/promises";
import * as path from "path";
import type { Workspace } from "@/common/types/project";
import { Err, Ok } from "@/common/types/result";
import { hasSrcBaseDir, type RuntimeConfig } from "@/common/types/runtime";
import type { Config } from "@/node/config";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import type { Runtime } from "@/node/runtime/Runtime";
import { createWorktreeArchiveHook } from "@/node/runtime/worktreeLifecycleHooks";
import { acquireCrossProcessLock } from "@/node/utils/main/crossProcessLock";
import * as removeManagedGitWorktreeModule from "@/node/worktree/removeManagedGitWorktree";
import type { AIService } from "./aiService";
import { createStreamLifecycleMocks } from "./agentSession.testHarness";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import { ContextManagementService } from "./contextManagement/contextManagementService";
import { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { InitStateManager } from "./initStateManager";
import { saveWorkspaces } from "./taskService.testHarness";
import { createTestHistoryService } from "./testHistoryService";
import { WorkspaceLifecycleHooks } from "./workspaceLifecycleHooks";
import { WorkspaceService } from "./workspaceService";

/**
 * Structural mutations (remove, rename, archive-delete/snapshot, unarchive-restore,
 * deleteWorktree) must refuse BEFORE any effect when they touch a protected agent-task
 * footprint: every host-local task row, whatever its status, plus any ordinary root whose
 * checkout a task row aliases. A cooperating backend sharing this config root may have
 * admitted a turn on that task from a config read this process never sees; nothing local
 * (terminal status, no stream here, local ownership) can prove otherwise. The alias scan
 * and the permitted physical effect of an ordinary root both serialize against task
 * publication through the registration lock.
 *
 * Real config, real directories, real cross-process lock; the runtime factory is the only
 * seam faked (to observe and perform physical effects deterministically).
 */
describe("WorkspaceService structural mutation guard", () => {
  const ROOT_ID = "root-ws-1234";
  const TASK_ID = "agent-task-5678";

  let config: Config;
  let cleanup: () => Promise<void>;
  let service: WorkspaceService;
  let projectPath: string;
  let srcBaseDir: string;
  let worktreeRuntime: RuntimeConfig;
  let physical: { deleted: string[]; renamed: Array<{ from: string; to: string }> };
  let deleteBarrier: (() => Promise<void>) | undefined;
  let createRuntimeSpy: Mock<typeof runtimeFactory.createRuntime>;
  let removeManagedGitWorktreeSpy: Mock<
    typeof removeManagedGitWorktreeModule.removeManagedGitWorktree
  >;
  let restoreSnapshotAfterUnarchive: ReturnType<typeof mock>;
  let captureSnapshotForArchive: ReturnType<typeof mock>;

  const registrationLockPath = () => path.join(config.rootDir, "workspace-registration.lock");
  const acquireRegistrationLock = (acquireTimeoutMs: number) =>
    acquireCrossProcessLock({
      lockPath: registrationLockPath(),
      acquireTimeoutMs,
      staleMs: 60_000,
      timeoutMessage: "registration lock busy",
    });

  const checkoutPath = (name: string) => path.join(srcBaseDir, "repo", name);
  const exists = (target: string) =>
    fsPromises
      .access(target)
      .then(() => true)
      .catch(() => false);
  const persistedRow = (id: string): Workspace | undefined => {
    for (const project of config.loadConfigOrDefault().projects.values()) {
      const row = project.workspaces.find((candidate) => candidate.id === id);
      if (row) return row;
    }
    return undefined;
  };
  const sessionDir = (id: string) => path.join(config.sessionsDir, id);

  function row(name: string, id: string, extra: Partial<Workspace> = {}): Workspace {
    return { path: checkoutPath(name), id, name, runtimeConfig: worktreeRuntime, ...extra };
  }
  function taskRow(name: string, id: string, extra: Partial<Workspace> = {}): Workspace {
    return row(name, id, { parentWorkspaceId: ROOT_ID, taskStatus: "reported", ...extra });
  }
  /** Seed rows and give every row a real checkout directory and session directory. */
  async function seed(
    rows: Workspace[],
    overrides: { worktreeArchiveBehavior?: "keep" | "delete" | "snapshot" } = {}
  ): Promise<void> {
    await saveWorkspaces(config, projectPath, rows, overrides);
    for (const entry of rows) {
      await fsPromises.mkdir(entry.path, { recursive: true });
      await fsPromises.writeFile(path.join(entry.path, "WORK.md"), `# ${entry.id!}\n`);
      await fsPromises.mkdir(sessionDir(entry.id!), { recursive: true });
      await fsPromises.writeFile(path.join(sessionDir(entry.id!), "chat.jsonl"), "");
    }
  }
  async function expectIntact(entry: Workspace): Promise<void> {
    expect(persistedRow(entry.id!)).toMatchObject({ id: entry.id, path: entry.path });
    expect(await exists(path.join(entry.path, "WORK.md"))).toBe(true);
    expect(await exists(path.join(sessionDir(entry.id!), "chat.jsonl"))).toBe(true);
  }
  function expectRefused(result: { success: boolean; error?: string }, fragment: string): void {
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain(fragment);
  }

  beforeEach(async () => {
    const harness = await createTestHistoryService();
    config = harness.config;
    cleanup = harness.cleanup;
    projectPath = path.join(harness.tempDir, "repo");
    srcBaseDir = path.join(harness.tempDir, "src");
    worktreeRuntime = { type: "worktree", srcBaseDir };
    await fsPromises.mkdir(projectPath, { recursive: true });
    physical = { deleted: [], renamed: [] };
    deleteBarrier = undefined;

    // Faked runtime: derives paths like WorktreeManager and performs the physical effect on
    // the real directories so a guard placed AFTER an effect is caught by the intact checks.
    createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockImplementation(
      (runtimeConfig, options) => {
        const derive = (targetProjectPath: string, name: string) =>
          hasSrcBaseDir(runtimeConfig)
            ? path.join(runtimeConfig.srcBaseDir, path.basename(targetProjectPath), name)
            : targetProjectPath;
        const fake = {
          getWorkspacePath: derive,
          // movePlanFile probes for a plan file after a rename; none exists here.
          getXumHome: () => config.rootDir,
          stat: () => Promise.reject(new Error("no plan file")),
          canDeleteWorkspaceWithoutForce: () => Promise.resolve({ success: true as const }),
          deleteWorkspace: async (targetProjectPath: string, name: string) => {
            const target = options?.workspacePath ?? derive(targetProjectPath, name);
            await deleteBarrier?.();
            await fsPromises.rm(target, { recursive: true, force: true });
            physical.deleted.push(target);
            return { success: true as const, deletedPath: target };
          },
          renameWorkspace: async (targetProjectPath: string, oldName: string, newName: string) => {
            const from = options?.workspacePath ?? derive(targetProjectPath, oldName);
            const to = derive(targetProjectPath, newName);
            await fsPromises.rename(from, to);
            physical.renamed.push({ from, to });
            return { success: true as const, oldPath: from, newPath: to };
          },
        };
        return fake as unknown as Runtime;
      }
    );
    removeManagedGitWorktreeSpy = spyOn(
      removeManagedGitWorktreeModule,
      "removeManagedGitWorktree"
    ).mockImplementation(async (_projectPath: string, worktreePath: string) => {
      await fsPromises.rm(worktreePath, { recursive: true, force: true });
      physical.deleted.push(worktreePath);
    });

    const aiService = Object.assign(new EventEmitter(), {
      ...createStreamLifecycleMocks(),
      getWorkspaceMetadata: async (workspaceId: string) => {
        const metadata = await config.getWorkspaceMetadataById(workspaceId);
        return metadata ? Ok(metadata) : Err(`Workspace not found: ${workspaceId}`);
      },
    }) as unknown as AIService;
    const initStateManager = Object.assign(new EventEmitter(), {
      getInitState: () => undefined,
      waitForInit: () => Promise.resolve(),
      clearInMemoryState: () => undefined,
      deleteInitStatus: () => Promise.resolve(),
    }) as unknown as InitStateManager;
    const backgroundProcessManager = {
      cleanup: () => Promise.resolve(),
      hasRunningBackgroundProcesses: () => false,
      hasOrphanedRunningBackgroundProcesses: () => Promise.resolve(false),
    } as unknown as BackgroundProcessManager;
    service = new WorkspaceService(
      config,
      harness.historyService,
      aiService,
      new ContextManagementService({ config, historyService: harness.historyService, aiService }),
      initStateManager,
      new ExtensionMetadataService(path.join(config.rootDir, "extension-metadata.json")),
      backgroundProcessManager
    );
    const hooks = new WorkspaceLifecycleHooks();
    hooks.registerAfterArchive(
      createWorktreeArchiveHook({
        getWorktreeArchiveBehavior: () =>
          config.loadConfigOrDefault().worktreeArchiveBehavior ?? "keep",
      })
    );
    service.setWorkspaceLifecycleHooks(hooks);
    restoreSnapshotAfterUnarchive = mock(() => Promise.resolve(Ok("restored" as const)));
    captureSnapshotForArchive = mock(() =>
      Promise.resolve(
        Ok({
          version: 1 as const,
          capturedAt: "2026-09-22T00:00:00.000Z",
          stateDirPath: "archive-state",
          projects: [],
        })
      )
    );
    service.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: () => Promise.resolve(Ok(undefined)),
      captureSnapshotForArchive,
      restoreSnapshotAfterUnarchive,
      getUnsupportedUntrackedPaths: () => Promise.resolve(Ok([])),
    });
  });

  afterEach(async () => {
    createRuntimeSpy.mockRestore();
    removeManagedGitWorktreeSpy.mockRestore();
    await cleanup();
  });

  describe("protected task rows refuse regardless of status or local ownership", () => {
    // A foreign backend admitted this turn: the row says running, this process has no stream.
    test("remove of a task with a foreign admitted turn refuses and leaves row, checkout and session", async () => {
      const task = taskRow("agent_exec_foreign", TASK_ID, {
        taskStatus: "running",
        taskAttemptId: "att_0123456789abcdef",
      });
      await seed([row("root", ROOT_ID), task]);

      const result = await service.remove(TASK_ID, true);

      expectRefused(result, "sub-agent task");
      await expectIntact(task);
      expect(physical.deleted).toEqual([]);
    });

    test.each([
      [
        "reported (locally settled)",
        { taskStatus: "reported" as const, reportedAt: "2026-09-22T00:00:00.000Z" },
      ],
      ["queued", { taskStatus: "queued" as const }],
      ["interrupted", { taskStatus: "interrupted" as const }],
    ])("remove of a %s task refuses", async (_label, extra) => {
      const task = taskRow("agent_exec_settled", TASK_ID, extra);
      await seed([row("root", ROOT_ID), task]);

      const result = await service.remove(TASK_ID, true);

      expectRefused(result, "sub-agent task");
      await expectIntact(task);
    });

    test("removeWhileTaskTreeLocked (task orchestration entry point) refuses the same way", async () => {
      const task = taskRow("agent_exec_tree", TASK_ID);
      await seed([row("root", ROOT_ID), task]);

      const result = await service.removeWhileTaskTreeLocked(TASK_ID, true);

      expectRefused(result, "sub-agent task");
      await expectIntact(task);
    });

    test("a legacy task row (no runtimeConfig, no attempt identity) refuses", async () => {
      const legacy: Workspace = {
        path: checkoutPath("agent_legacy"),
        id: TASK_ID,
        name: "agent_legacy",
        parentWorkspaceId: ROOT_ID,
      };
      await seed([row("root", ROOT_ID), legacy]);

      expectRefused(await service.remove(TASK_ID, true), "sub-agent task");
      expectRefused(await service.rename(TASK_ID, "renamed-legacy"), "sub-agent task");
      await expectIntact(legacy);
      expect(physical.renamed).toEqual([]);
    });

    test("a shared (isolation: none) child refuses removal even though it owns no directory", async () => {
      const root = row("root", ROOT_ID);
      const shared = taskRow("agent_shared", TASK_ID, { path: root.path, taskIsolation: "none" });
      await seed([root, shared]);

      expectRefused(await service.remove(TASK_ID, true), "sub-agent task");
      await expectIntact(shared);
      expect(persistedRow(TASK_ID)).toBeDefined();
    });

    test("rename of a task refuses before the checkout moves or the config path changes", async () => {
      const task = taskRow("agent_exec_rename", TASK_ID);
      await seed([row("root", ROOT_ID), task]);

      const result = await service.rename(TASK_ID, "agent_exec_renamed");

      expectRefused(result, "sub-agent task");
      await expectIntact(task);
      expect(physical.renamed).toEqual([]);
      expect(await exists(checkoutPath("agent_exec_renamed"))).toBe(false);
    });

    test.each(["delete", "snapshot"] as const)(
      "archive of a task under the %s policy refuses before archivedAt or any capture",
      async (behavior) => {
        const task = taskRow("agent_exec_archive", TASK_ID);
        await seed([row("root", ROOT_ID), task], { worktreeArchiveBehavior: behavior });

        const result = await service.archive(TASK_ID);

        expectRefused(result, "sub-agent task");
        await expectIntact(task);
        expect(persistedRow(TASK_ID)?.archivedAt).toBeUndefined();
        expect(captureSnapshotForArchive).not.toHaveBeenCalled();
        expect(removeManagedGitWorktreeSpy).not.toHaveBeenCalled();
      }
    );

    test("keep-only archive of a task stays available and leaves the checkout", async () => {
      const task = taskRow("agent_exec_keep", TASK_ID);
      await seed([row("root", ROOT_ID), task], { worktreeArchiveBehavior: "keep" });

      const result = await service.archive(TASK_ID);

      expect(result).toEqual(Ok({ kind: "archived" }));
      expect(persistedRow(TASK_ID)?.archivedAt).toBeTruthy();
      expect(await exists(path.join(task.path, "WORK.md"))).toBe(true);
      expect(removeManagedGitWorktreeSpy).not.toHaveBeenCalled();
    });

    test("unarchive of a task with an archive snapshot refuses before restoring; without one it flips", async () => {
      const snapshot = {
        version: 1 as const,
        capturedAt: "2026-09-22T00:00:00.000Z",
        stateDirPath: "archive-state",
        projects: [],
      };
      const restorable = taskRow("agent_exec_restore", TASK_ID, {
        archivedAt: "2026-09-22T01:00:00.000Z",
        worktreeArchiveSnapshot: snapshot,
      });
      const plain = taskRow("agent_exec_plain", "agent-task-plain", {
        archivedAt: "2026-09-22T01:00:00.000Z",
      });
      await seed([row("root", ROOT_ID), restorable, plain]);

      expectRefused(await service.unarchive(TASK_ID), "sub-agent task");
      expect(restoreSnapshotAfterUnarchive).not.toHaveBeenCalled();
      expect(persistedRow(TASK_ID)?.unarchivedAt).toBeUndefined();
      expect(persistedRow(TASK_ID)?.worktreeArchiveSnapshot).toEqual(snapshot);

      expect(await service.unarchive("agent-task-plain")).toEqual(Ok(undefined));
      expect(persistedRow("agent-task-plain")?.unarchivedAt).toBeTruthy();
    });

    test("deleteWorktree of an archived task refuses and leaves the worktree", async () => {
      const task = taskRow("agent_exec_wt", TASK_ID, { archivedAt: "2026-09-22T01:00:00.000Z" });
      await seed([row("root", ROOT_ID), task]);

      expectRefused(await service.deleteWorktree(TASK_ID), "sub-agent task");
      expect(removeManagedGitWorktreeSpy).not.toHaveBeenCalled();
      await expectIntact(task);
    });
  });

  describe("ordinary roots refuse only when a task row aliases their footprint", () => {
    test("a root whose checkout a REPORTED shared child points at refuses removal and rename", async () => {
      const root = row("root", ROOT_ID);
      const shared = taskRow("agent_shared", TASK_ID, { path: root.path, taskIsolation: "none" });
      await seed([root, shared]);

      expectRefused(await service.remove(ROOT_ID, true), `"${TASK_ID}"`);
      expectRefused(await service.rename(ROOT_ID, "root-renamed"), `"${TASK_ID}"`);
      await expectIntact(root);
      await expectIntact(shared);
      expect(physical.deleted).toEqual([]);
      expect(physical.renamed).toEqual([]);
    });

    test("a symlinked spelling of the root checkout on a task row still counts as an alias", async () => {
      const root = row("root", ROOT_ID);
      const linkPath = path.join(config.rootDir, "task-alias-link");
      await seed([root]);
      await fsPromises.symlink(root.path, linkPath);
      await saveWorkspaces(config, projectPath, [
        root,
        taskRow("agent_via_link", TASK_ID, { path: linkPath }),
      ]);

      expectRefused(await service.remove(ROOT_ID, true), `"${TASK_ID}"`);
      await expectIntact(root);
    });

    test("a task checkout nested inside the root checkout blocks the root's removal", async () => {
      const root = row("root", ROOT_ID);
      const nested = taskRow("agent_nested", TASK_ID, { path: path.join(root.path, "nested") });
      await seed([root, nested]);

      expectRefused(await service.remove(ROOT_ID, true), `"${TASK_ID}"`);
      await expectIntact(root);
      await expectIntact(nested);
    });

    test("an alias whose physical identity cannot be established refuses (fail closed)", async () => {
      const root = row("root", ROOT_ID);
      const loop = path.join(config.rootDir, "loop-link");
      await fsPromises.symlink(loop, loop); // ELOOP: neither absent nor resolvable
      await seed([root]);
      await saveWorkspaces(config, projectPath, [
        root,
        taskRow("agent_loop", TASK_ID, { path: loop }),
      ]);

      expectRefused(await service.remove(ROOT_ID, true), "cannot be verified");
      await expectIntact(root);
    });

    test("an unreadable config refuses a root removal instead of reading as 'no tasks'", async () => {
      const root = row("root", ROOT_ID);
      await seed([root]);
      await fsPromises.writeFile(path.join(config.rootDir, "config.json"), "{ not json", "utf-8");

      expectRefused(await service.remove(ROOT_ID, true), "unreadable");
      expect(await exists(path.join(root.path, "WORK.md"))).toBe(true);
      expect(await fsPromises.readFile(path.join(config.rootDir, "config.json"), "utf-8")).toBe(
        "{ not json"
      );
    });

    test("a root with a delete archive policy refuses archive when a shared child aliases it", async () => {
      const root = row("root", ROOT_ID);
      const shared = taskRow("agent_shared", TASK_ID, { path: root.path, taskIsolation: "none" });
      await seed([root, shared], { worktreeArchiveBehavior: "delete" });

      expectRefused(await service.archive(ROOT_ID), `"${TASK_ID}"`);
      expect(persistedRow(ROOT_ID)?.archivedAt).toBeUndefined();
      expect(removeManagedGitWorktreeSpy).not.toHaveBeenCalled();
      await expectIntact(root);
    });

    test("an alias-free root keeps its ordinary behavior: remove deletes, rename moves, archive-delete deletes", async () => {
      const root = row("root", ROOT_ID);
      const other = row("other", "root-ws-other");
      const unrelatedTask = taskRow("agent_elsewhere", TASK_ID, {
        parentWorkspaceId: "root-ws-other",
      });
      await seed([root, other, unrelatedTask], { worktreeArchiveBehavior: "delete" });

      expect(await service.rename(ROOT_ID, "root-renamed")).toEqual(
        Ok({ newWorkspaceId: ROOT_ID })
      );
      expect(physical.renamed).toEqual([{ from: root.path, to: checkoutPath("root-renamed") }]);
      expect(persistedRow(ROOT_ID)?.path).toBe(checkoutPath("root-renamed"));

      expect(await service.remove(ROOT_ID, true)).toEqual(Ok(undefined));
      expect(physical.deleted).toEqual([checkoutPath("root-renamed")]);
      expect(persistedRow(ROOT_ID)).toBeUndefined();

      expect(await service.archive("root-ws-other")).toEqual(Ok({ kind: "archived" }));
      expect(removeManagedGitWorktreeSpy).toHaveBeenCalledWith(projectPath, other.path);
      await expectIntact(unrelatedTask);
    });

    test("an id with no registered row refuses instead of deleting its session as a phantom", async () => {
      // Without a row nothing proves the id is outside a protected footprint (a legacy
      // id-less task, a row a cooperating backend re-registered): refuse before any effect.
      await seed([row("root", ROOT_ID)]);
      const phantomSessionDir = sessionDir("phantom-0001");
      await fsPromises.mkdir(phantomSessionDir, { recursive: true });
      await fsPromises.writeFile(path.join(phantomSessionDir, "chat.jsonl"), "");

      expectRefused(await service.remove("phantom-0001", true), "not registered");
      expect(await exists(path.join(phantomSessionDir, "chat.jsonl"))).toBe(true);
    });

    test("an off-host root is outside every host-local footprint even when spellings collide", async () => {
      const remote = row("remote", ROOT_ID, {
        path: "/srv/repo/remote",
        runtimeConfig: { type: "ssh", host: "box.invalid", srcBaseDir: "/srv" },
      });
      const collidingTask = taskRow("agent_local", TASK_ID, { path: "/srv/repo/remote" });
      await saveWorkspaces(config, projectPath, [remote, collidingTask]);

      expect(await service.remove(ROOT_ID, true)).toEqual(Ok(undefined));
      expect(persistedRow(ROOT_ID)).toBeUndefined();
      expect(persistedRow(TASK_ID)).toBeDefined();
    });
  });

  describe("root mutation and task publication are fenced through the registration lock", () => {
    test("publication that lands first (under the lock) turns an initially alias-free removal into a refusal", async () => {
      const root = row("root", ROOT_ID);
      await seed([root]);
      // The producer holds the registration lock while preparing a shared child of this root.
      const releasePublication = await acquireRegistrationLock(5_000);
      const removal = service.remove(ROOT_ID, true);
      await new Promise((resolve) => setTimeout(resolve, 150));
      // Blocked before any effect: nothing deleted, row present.
      expect(physical.deleted).toEqual([]);
      await expectIntact(root);
      await config.editConfig((cfg) => {
        cfg.projects
          .get(projectPath)!
          .workspaces.push(
            taskRow("agent_shared", TASK_ID, { path: root.path, taskIsolation: "none" })
          );
        return cfg;
      });
      await releasePublication();

      expectRefused(await removal, `"${TASK_ID}"`);
      await expectIntact(root);
      expect(persistedRow(TASK_ID)).toBeDefined();
      expect(physical.deleted).toEqual([]);
    });

    test("a removal that wins the lock excludes publication across its physical effect", async () => {
      const root = row("root", ROOT_ID);
      await seed([root]);
      const events: string[] = [];
      let contendedDuringDeletion: string | undefined;
      let publication: Promise<void> | undefined;
      deleteBarrier = async () => {
        // A producer arriving mid-deletion cannot take the lock ...
        try {
          const release = await acquireRegistrationLock(300);
          await release();
          contendedDuringDeletion = "acquired";
        } catch (error) {
          contendedDuringDeletion = error instanceof Error ? error.message : String(error);
        }
        // ... and one that waits proceeds only after the removal settled.
        publication = acquireRegistrationLock(10_000).then(async (release) => {
          events.push(`published (root registered: ${persistedRow(ROOT_ID) !== undefined})`);
          await release();
        });
        events.push("deleted");
      };

      expect(await service.remove(ROOT_ID, true)).toEqual(Ok(undefined));
      await publication;

      expect(contendedDuringDeletion).toBe("registration lock busy");
      // The waiting publication got the lock only once the removal had deregistered the root,
      // so a producer publishing a child of it sees the parent gone instead of a vanishing cwd.
      expect(events).toEqual(["deleted", "published (root registered: false)"]);
      expect(physical.deleted).toEqual([root.path]);
    });
  });
});
