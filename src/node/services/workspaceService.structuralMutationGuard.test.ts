import { afterEach, beforeEach, describe, expect, mock, spyOn, test, type Mock } from "bun:test";
import { execFile } from "child_process";
import { EventEmitter } from "events";
import * as fsPromises from "fs/promises";
import * as path from "path";
import { promisify } from "util";
import type { Workspace } from "@/common/types/project";
import { Err, Ok } from "@/common/types/result";
import { STRUCTURAL_FOOTPRINT_SCAN_TIMEOUT_MS } from "@/constants/terminationTimeouts";
import { hasSrcBaseDir, type RuntimeConfig } from "@/common/types/runtime";
import { Config } from "@/node/config";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import type { Runtime } from "@/node/runtime/Runtime";
import { expandTilde } from "@/node/runtime/tildeExpansion";
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
  let tempDir: string;
  let projectPath: string;
  let srcBaseDir: string;
  let worktreeRuntime: RuntimeConfig;
  let physical: { deleted: string[]; renamed: Array<{ from: string; to: string }> };
  let deleteBarrier: (() => Promise<void>) | undefined;
  let renameBarrier: (() => Promise<void>) | undefined;
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
    tempDir = harness.tempDir;
    projectPath = path.join(harness.tempDir, "repo");
    srcBaseDir = path.join(harness.tempDir, "src");
    worktreeRuntime = { type: "worktree", srcBaseDir };
    await fsPromises.mkdir(projectPath, { recursive: true });
    physical = { deleted: [], renamed: [] };
    deleteBarrier = undefined;
    renameBarrier = undefined;

    // Faked runtime: derives its operation target from the NAME like the real
    // WorktreeManager.deleteWorkspace/renameWorkspace do (the persisted row path is not what
    // they act on) and performs the physical effect on the real directories, so a guard
    // placed AFTER an effect — or one that scanned only the stored path — is caught by the
    // intact checks.
    createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockImplementation(
      (runtimeConfig) => {
        const derive = (targetProjectPath: string, name: string) =>
          hasSrcBaseDir(runtimeConfig)
            ? path.join(
                expandTilde(runtimeConfig.srcBaseDir),
                path.basename(targetProjectPath),
                name
              )
            : runtimeConfig.type === "devcontainer"
              ? // DevcontainerRuntime: a host worktree under `new Config().srcDir` (runtimeFactory).
                path.join(new Config().srcDir, path.basename(targetProjectPath), name)
              : targetProjectPath;
        const fake = {
          getWorkspacePath: derive,
          // movePlanFile probes for a plan file after a rename; none exists here.
          getXumHome: () => config.rootDir,
          stat: () => Promise.reject(new Error("no plan file")),
          canDeleteWorkspaceWithoutForce: () => Promise.resolve({ success: true as const }),
          deleteWorkspace: async (targetProjectPath: string, name: string) => {
            const target = derive(targetProjectPath, name);
            await deleteBarrier?.();
            await fsPromises.rm(target, { recursive: true, force: true });
            physical.deleted.push(target);
            return { success: true as const, deletedPath: target };
          },
          renameWorkspace: async (targetProjectPath: string, oldName: string, newName: string) => {
            await renameBarrier?.();
            const from = derive(targetProjectPath, oldName);
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

    test("a row with an empty parentWorkspaceId is protected, as the preparation validator treats it (fail closed)", async () => {
      const malformed = taskRow("agent_empty_parent", TASK_ID, { parentWorkspaceId: "" });
      await seed([row("root", ROOT_ID), malformed]);
      expect(persistedRow(TASK_ID)?.parentWorkspaceId).toBe("");

      expectRefused(await service.remove(TASK_ID, true), "sub-agent task");
      expectRefused(await service.rename(TASK_ID, "agent_renamed"), "sub-agent task");
      await expectIntact(malformed);
      expect(physical.deleted).toEqual([]);
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

    test("a footprint scan stalled on a protected task's filesystem is deadline-bounded: the removal refuses, the registration lock is released, and the late read authorizes nothing", async () => {
      const root = row("root", ROOT_ID);
      const task = taskRow("agent_stalled", TASK_ID, { parentWorkspaceId: "root-ws-other" });
      await seed([root, row("other", "root-ws-other"), task]);
      // A stalled FUSE/NFS mount under the task checkout: its `.git` probe never answers.
      const stalledGate = Promise.withResolvers<void>();
      const lateReadDone = Promise.withResolvers<void>();
      const stalledPath = path.join(task.path, ".git");
      const lstat = fsPromises.lstat;
      const probe = spyOn(fsPromises, "lstat").mockImplementation((async (
        ...args: Parameters<typeof fsPromises.lstat>
      ) => {
        if (String(args[0]) !== stalledPath) return lstat(...args);
        await stalledGate.promise;
        try {
          return await lstat(...args);
        } finally {
          lateReadDone.resolve();
        }
      }) as typeof fsPromises.lstat);
      // Shorten only the scan deadline (no knob in production): its timer fires in 20 ms.
      const realSetTimeout = globalThis.setTimeout;
      const timers = spyOn(globalThis, "setTimeout").mockImplementation(((
        handler: () => void,
        ms?: number
      ) =>
        realSetTimeout(
          handler,
          ms === STRUCTURAL_FOOTPRINT_SCAN_TIMEOUT_MS ? 20 : ms
        )) as unknown as typeof setTimeout);
      try {
        const refused = await service.remove(ROOT_ID, true);
        expectRefused(refused, "cannot be verified");
        expectRefused(refused, "timed out");
      } finally {
        timers.mockRestore();
      }
      // Released on refusal: another registrant gets the lock at once.
      const release = await acquireRegistrationLock(1_000);
      await release();
      // The stalled read completes late; its verdict must not reach any effect.
      stalledGate.resolve();
      await lateReadDone.promise;
      probe.mockRestore();
      await expectIntact(root);
      await expectIntact(task);
      expect(physical.deleted).toEqual([]);
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

    // Malformed config: Config.removeWorkspace drops EVERY row with the id and removal deletes
    // the id's session directory, so classifying by the first row would take the protected task
    // row sharing the id down with an ordinary one (an off-host first row even skipped the scan).
    const rowsWithId = (id: string) =>
      [...config.loadConfigOrDefault().projects.values()].flatMap((project) =>
        project.workspaces.filter((candidate) => candidate.id === id)
      );
    async function expectDuplicatesIntact(entries: Workspace[]): Promise<void> {
      expect(rowsWithId(entries[0].id!).map((entry) => entry.path)).toEqual(
        entries.map((entry) => entry.path)
      );
      for (const entry of entries)
        expect(await exists(path.join(entry.path, "WORK.md"))).toBe(true);
      expect(await exists(path.join(sessionDir(entries[0].id!), "chat.jsonl"))).toBe(true);
    }

    test("an ordinary row sharing its id with a protected task row refuses remove, rename and a destructive archive, leaving every row, checkout and the session", async () => {
      const ordinary = row("dup-root", ROOT_ID);
      const task = taskRow("agent_dup", ROOT_ID, { parentWorkspaceId: "root-ws-other" });
      await seed([row("other", "root-ws-other"), ordinary, task], {
        worktreeArchiveBehavior: "delete",
      });

      expectRefused(await service.remove(ROOT_ID, true), "share this id");
      expectRefused(await service.rename(ROOT_ID, "dup-renamed"), "share this id");
      expectRefused(await service.archive(ROOT_ID), "share this id");
      await expectDuplicatesIntact([ordinary, task]);
      expect(rowsWithId(ROOT_ID).map((entry) => entry.archivedAt)).toEqual([undefined, undefined]);
      expect(physical.deleted).toEqual([]);
      expect(physical.renamed).toEqual([]);
      expect(removeManagedGitWorktreeSpy).not.toHaveBeenCalled();
    });

    test("an off-host first row sharing its id with a protected task row refuses removal and rename", async () => {
      const offHost = row("dup-remote", ROOT_ID, {
        runtimeConfig: { type: "ssh", host: "box.invalid", srcBaseDir },
      });
      const task = taskRow("agent_dup", ROOT_ID, { parentWorkspaceId: "root-ws-other" });
      await seed([row("other", "root-ws-other"), offHost, task]);

      expectRefused(await service.remove(ROOT_ID, true), "share this id");
      expectRefused(await service.rename(ROOT_ID, "dup-renamed"), "share this id");
      await expectDuplicatesIntact([offHost, task]);
      expect(physical.deleted).toEqual([]);
      expect(physical.renamed).toEqual([]);
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

    test("a stored root path that differs from the runtime's name-derived target still protects a task at that target", async () => {
      // WorktreeRuntime.deleteWorkspace/renameWorkspace act on <srcBaseDir>/<project>/<name>,
      // not on the persisted row path: a stale stored path must not let the operation land on a
      // derived target the guard never scanned.
      const root = row("root", ROOT_ID, { path: checkoutPath("root-stored") });
      const taskAtDerivedTarget = taskRow("agent_at_target", TASK_ID, {
        path: checkoutPath("root"),
      });
      await seed([root, taskAtDerivedTarget]);

      expectRefused(await service.remove(ROOT_ID, true), `"${TASK_ID}"`);
      expectRefused(await service.rename(ROOT_ID, "root-renamed"), `"${TASK_ID}"`);
      await expectIntact(taskAtDerivedTarget);
      await expectIntact(root);
      expect(physical.deleted).toEqual([]);
      expect(physical.renamed).toEqual([]);
    });

    describe("rows the runtime derives through the default worktree config or a tilde srcBaseDir", () => {
      // Config.getAllMetadata substitutes DEFAULT_RUNTIME_CONFIG (worktree, `~/.xum/src`) for a
      // missing runtimeConfig and WorktreeManager expands the tilde through getXumHome(), so
      // with XUM_ROOT pointed at the harness root both spell <tempDir>/src == srcBaseDir.
      let previousXumRoot: string | undefined;
      beforeEach(() => {
        previousXumRoot = process.env.XUM_ROOT;
        process.env.XUM_ROOT = tempDir;
      });
      afterEach(() => {
        if (previousXumRoot === undefined) delete process.env.XUM_ROOT;
        else process.env.XUM_ROOT = previousXumRoot;
      });

      test("a legacy root without a runtimeConfig still protects a task at its default-derived target", async () => {
        const legacyRoot = row("root", ROOT_ID, {
          path: checkoutPath("root-stored"),
          runtimeConfig: undefined,
        });
        const taskAtDerivedTarget = taskRow("agent_at_target", TASK_ID, {
          path: checkoutPath("root"),
        });
        await seed([legacyRoot, taskAtDerivedTarget]);
        expect(persistedRow(ROOT_ID)?.runtimeConfig).toBeUndefined();

        expectRefused(await service.remove(ROOT_ID, true), `"${TASK_ID}"`);
        expectRefused(await service.rename(ROOT_ID, "root-renamed"), `"${TASK_ID}"`);
        await expectIntact(taskAtDerivedTarget);
        await expectIntact(legacyRoot);
        expect(physical.deleted).toEqual([]);
        expect(physical.renamed).toEqual([]);
      });

      test.each(["delete", "snapshot"] as const)(
        "a legacy root without a runtimeConfig is a managed worktree for archive (%s policy): a shared child's alias refuses before archivedAt, capture or deletion",
        async (behavior) => {
          const legacyRoot = row("root", ROOT_ID, { runtimeConfig: undefined });
          const shared = taskRow("agent_shared", TASK_ID, {
            path: legacyRoot.path,
            taskIsolation: "none",
          });
          await seed([legacyRoot, shared], { worktreeArchiveBehavior: behavior });
          expect(persistedRow(ROOT_ID)?.runtimeConfig).toBeUndefined();

          expectRefused(await service.archive(ROOT_ID), `"${TASK_ID}"`);
          expect(persistedRow(ROOT_ID)?.archivedAt).toBeUndefined();
          expect(captureSnapshotForArchive).not.toHaveBeenCalled();
          expect(removeManagedGitWorktreeSpy).not.toHaveBeenCalled();
          await expectIntact(legacyRoot);
          await expectIntact(shared);
        }
      );

      test("a root whose srcBaseDir is spelled with a tilde protects a task at the expanded target", async () => {
        const tildeRoot = row("root", ROOT_ID, {
          path: checkoutPath("root-stored"),
          runtimeConfig: { type: "worktree", srcBaseDir: "~/.xum/src" },
        });
        const taskAtDerivedTarget = taskRow("agent_at_target", TASK_ID, {
          path: checkoutPath("root"),
        });
        await seed([tildeRoot, taskAtDerivedTarget]);

        expectRefused(await service.remove(ROOT_ID, true), `"${TASK_ID}"`);
        expectRefused(await service.rename(ROOT_ID, "root-renamed"), `"${TASK_ID}"`);
        await expectIntact(taskAtDerivedTarget);
        await expectIntact(tildeRoot);
        expect(physical.deleted).toEqual([]);
        expect(physical.renamed).toEqual([]);
      });
    });

    test("a local-runtime task's project execution directory protects it even when its stored path is unrelated", async () => {
      // LocalRuntime forks execute in the PROJECT directory of their bucket (no checkout of
      // their own), whatever the row's stored path says. A worktree root whose name-derived
      // target contains that project directory would destroy the task's execution directory,
      // so the scan must cover the bucket path, not only the stored one.
      const root = row("root", ROOT_ID);
      const nestedProjectPath = path.join(root.path, "nested-project");
      const localTask: Workspace = {
        path: path.join(tempDir, "unrelated-stored"),
        id: TASK_ID,
        name: "local-task",
        parentWorkspaceId: ROOT_ID,
        taskStatus: "reported",
        runtimeConfig: { type: "local" },
      };
      await seed([root]);
      await fsPromises.mkdir(nestedProjectPath, { recursive: true });
      await fsPromises.writeFile(path.join(nestedProjectPath, "PROJECT.md"), "nested\n");
      await fsPromises.mkdir(localTask.path, { recursive: true });
      await fsPromises.mkdir(sessionDir(TASK_ID), { recursive: true });
      await fsPromises.writeFile(path.join(sessionDir(TASK_ID), "chat.jsonl"), "");
      await saveWorkspaces(config, projectPath, [root], {
        extraProjects: [[nestedProjectPath, { trusted: true, workspaces: [localTask] }]],
      });

      expectRefused(await service.remove(ROOT_ID, true), `"${TASK_ID}"`);
      expectRefused(await service.rename(ROOT_ID, "root-renamed"), `"${TASK_ID}"`);
      await expectIntact(root);
      expect(await exists(path.join(nestedProjectPath, "PROJECT.md"))).toBe(true);
      expect(persistedRow(TASK_ID)).toMatchObject({ path: localTask.path });
      expect(await exists(path.join(sessionDir(TASK_ID), "chat.jsonl"))).toBe(true);
      expect(physical.deleted).toEqual([]);
      expect(physical.renamed).toEqual([]);
    });

    test("a legacy task worktree backed by a repo nested inside the root blocks the root's removal and rename (real git)", async () => {
      const git = async (cwd: string, ...args: string[]) => {
        await promisify(execFile)("git", args, {
          cwd,
          env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        });
      };
      const root = row("root", ROOT_ID);
      await seed([root]);
      // A project repository nested inside the ordinary root's checkout ...
      const nestedRepo = path.join(root.path, "nested");
      await fsPromises.mkdir(nestedRepo, { recursive: true });
      await git(nestedRepo, "init", "-q");
      await fsPromises.writeFile(path.join(nestedRepo, "README.md"), "nested\n");
      await git(nestedRepo, "add", "README.md");
      await git(
        nestedRepo,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        "commit",
        "-q",
        "-m",
        "init"
      );
      // ... backs a legacy task checkout OUTSIDE the root: its `.git` file points at the admin
      // dir under the nested repo, which the root's deletion or move would destroy.
      const legacyCheckout = path.join(tempDir, "legacy-task");
      await git(nestedRepo, "worktree", "add", "-q", legacyCheckout, "-b", "legacy-task");
      const adminDir = path.join(nestedRepo, ".git", "worktrees", "legacy-task");
      expect((await fsPromises.stat(path.join(legacyCheckout, ".git"))).isFile()).toBe(true);
      expect(await exists(adminDir)).toBe(true);
      const legacyTask: Workspace = {
        path: legacyCheckout,
        id: TASK_ID,
        name: "legacy-task",
        parentWorkspaceId: ROOT_ID,
      };
      await saveWorkspaces(config, projectPath, [root, legacyTask]);

      expectRefused(await service.remove(ROOT_ID, true), `"${TASK_ID}"`);
      expectRefused(await service.rename(ROOT_ID, "root-renamed"), `"${TASK_ID}"`);
      await expectIntact(root);
      expect(await exists(adminDir)).toBe(true);
      expect(await exists(path.join(legacyCheckout, "README.md"))).toBe(true);
      expect(persistedRow(TASK_ID)).toMatchObject({ path: legacyCheckout });
      expect(physical.deleted).toEqual([]);
      expect(physical.renamed).toEqual([]);
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

  describe("devcontainer checkouts are host worktrees, protected like host-local ones", () => {
    // DevcontainerRuntime keeps its checkout on the host through a WorktreeManager rooted at
    // `new Config().srcDir`: with XUM_ROOT at the harness root that is srcBaseDir. Checkout
    // preparation exempts these rows (plugin servers are never offered there); the guard not.
    const devcontainer: RuntimeConfig = {
      type: "devcontainer",
      configPath: ".devcontainer/x.json",
    };
    let previousXumRoot: string | undefined;
    beforeEach(() => {
      previousXumRoot = process.env.XUM_ROOT;
      process.env.XUM_ROOT = tempDir;
    });
    afterEach(() => {
      if (previousXumRoot === undefined) delete process.env.XUM_ROOT;
      else process.env.XUM_ROOT = previousXumRoot;
    });
    const devRow = (name: string, id: string, extra: Partial<Workspace> = {}) =>
      row(name, id, { runtimeConfig: devcontainer, ...extra });
    const devTaskRow = (name: string, id: string, extra: Partial<Workspace> = {}) =>
      taskRow(name, id, { runtimeConfig: devcontainer, ...extra });

    test("a devcontainer task refuses remove and rename, leaving row, checkout and session", async () => {
      const task = devTaskRow("agent_dev", TASK_ID);
      await seed([devRow("root", ROOT_ID), task]);

      expectRefused(await service.remove(TASK_ID, true), "sub-agent task");
      expectRefused(await service.rename(TASK_ID, "agent_dev_renamed"), "sub-agent task");
      await expectIntact(task);
      expect(physical.deleted).toEqual([]);
      expect(physical.renamed).toEqual([]);
    });

    test.each(["delete", "snapshot"] as const)(
      "archive of a devcontainer task (%s policy) stays available: it never deletes or snapshots that checkout",
      async (behavior) => {
        const task = devTaskRow("agent_dev", TASK_ID);
        await seed([devRow("root", ROOT_ID), task], { worktreeArchiveBehavior: behavior });

        expect(await service.archive(TASK_ID)).toEqual(Ok({ kind: "archived" }));
        expect(persistedRow(TASK_ID)?.archivedAt).toBeTruthy();
        await expectIntact(task);
        expect(captureSnapshotForArchive).not.toHaveBeenCalled();
        expect(removeManagedGitWorktreeSpy).not.toHaveBeenCalled();
      }
    );

    test("a devcontainer root whose host worktree a shared child aliases refuses remove and rename", async () => {
      const root = devRow("root", ROOT_ID);
      const shared = devTaskRow("agent_shared", TASK_ID, {
        path: root.path,
        taskIsolation: "none",
      });
      await seed([root, shared]);

      expectRefused(await service.remove(ROOT_ID, true), `"${TASK_ID}"`);
      expectRefused(await service.rename(ROOT_ID, "root-renamed"), `"${TASK_ID}"`);
      await expectIntact(root);
      await expectIntact(shared);
      expect(physical.deleted).toEqual([]);
      expect(physical.renamed).toEqual([]);
    });

    test("an alias-free devcontainer root keeps its ordinary behavior: rename moves and remove deletes its host worktree", async () => {
      const root = devRow("root", ROOT_ID);
      const unrelatedTask = devTaskRow("agent_elsewhere", TASK_ID, {
        parentWorkspaceId: "root-ws-other",
      });
      await seed([root, devRow("other", "root-ws-other"), unrelatedTask]);

      expect(await service.rename(ROOT_ID, "root-renamed")).toEqual(
        Ok({ newWorkspaceId: ROOT_ID })
      );
      expect(physical.renamed).toEqual([{ from: root.path, to: checkoutPath("root-renamed") }]);
      expect(await service.remove(ROOT_ID, true)).toEqual(Ok(undefined));
      expect(physical.deleted).toEqual([checkoutPath("root-renamed")]);
      expect(persistedRow(ROOT_ID)).toBeUndefined();
      await expectIntact(unrelatedTask);
    });

    // A devcontainer task forks its checkout LAZILY (at dequeue / reserved launch, outside the
    // registration lock): until it is launched its own checkout cannot protect anything, so its
    // fork source must.
    test.each([
      ["queued", "refused"],
      ["starting", "refused"],
      ["running", "allowed"],
    ] as const)(
      "a %s devcontainer task's fork source (the parent's checkout and its Git backing) is protected: removal %s (real git)",
      async (taskStatus, expected) => {
        const git = (cwd: string, ...args: string[]) =>
          promisify(execFile)("git", args, {
            cwd,
            env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
          });
        // An ordinary workspace whose checkout holds the repository backing the parent.
        const backing = row("backing", "backing-ws");
        await seed([backing]);
        const nestedRepo = path.join(backing.path, "nested");
        await fsPromises.mkdir(nestedRepo, { recursive: true });
        await git(nestedRepo, "init", "-q");
        await fsPromises.writeFile(path.join(nestedRepo, "README.md"), "nested\n");
        await git(nestedRepo, "add", "README.md");
        await git(
          nestedRepo,
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@x.invalid",
          "commit",
          "-qm",
          "i"
        );
        const parentPath = path.join(srcBaseDir, "nested", "parent");
        await git(nestedRepo, "worktree", "add", "-q", parentPath, "-b", "parent");
        const adminDir = path.join(nestedRepo, ".git", "worktrees", "parent");
        const parent = devRow("parent", ROOT_ID, { path: parentPath });
        const task = devTaskRow("agent_pending", TASK_ID, {
          taskStatus,
          path: path.join(srcBaseDir, "nested", "agent_pending"),
        });
        await saveWorkspaces(config, projectPath, [backing, parent, task]);

        if (expected === "allowed") {
          expect(await service.remove("backing-ws", true)).toEqual(Ok(undefined));
          expect(physical.deleted).toEqual([backing.path]);
          return;
        }
        expectRefused(await service.remove("backing-ws", true), `"${TASK_ID}"`);
        expectRefused(await service.remove(ROOT_ID, true), `"${TASK_ID}"`);
        expectRefused(await service.rename(ROOT_ID, "parent-renamed"), `"${TASK_ID}"`);
        expect(physical.deleted).toEqual([]);
        expect(physical.renamed).toEqual([]);
        expect(await exists(adminDir)).toBe(true);
        expect(persistedRow(ROOT_ID)).toMatchObject({ path: parentPath });
      }
    );
  });

  // lXKHj: an off-host root's effects act BY ID after the guard (session removal, deregistration,
  // the config rewrite of a rename), so a publication landing a row with the same id meanwhile
  // must not be taken down with it.
  describe("off-host roots re-derive their target by id around their effects", () => {
    const remoteRuntime = (): RuntimeConfig => ({
      type: "ssh",
      host: "box.invalid",
      srcBaseDir,
    });
    const rowsWithId = (id: string) =>
      [...config.loadConfigOrDefault().projects.values()].flatMap((project) =>
        project.workspaces.filter((candidate) => candidate.id === id)
      );
    const publishSameIdTask = async (): Promise<Workspace> => {
      const task = taskRow("agent_dup", ROOT_ID, { parentWorkspaceId: "root-ws-other" });
      await fsPromises.mkdir(task.path, { recursive: true });
      await config.editConfig((cfg) => {
        cfg.projects.get(projectPath)!.workspaces.push(task);
        return cfg;
      });
      return task;
    };

    test("a same-id row published after the guard refuses the removal before any effect", async () => {
      const remote = row("remote", ROOT_ID, { runtimeConfig: remoteRuntime() });
      await seed([row("other", "root-ws-other"), remote]);
      const internals = service as unknown as {
        guardStructuralMutation: (...args: unknown[]) => Promise<unknown>;
      };
      const realGuard = internals.guardStructuralMutation.bind(service);
      let task: Workspace | undefined;
      const guard = spyOn(internals, "guardStructuralMutation").mockImplementation(
        async (...args: unknown[]) => {
          const verdict = await realGuard(...args);
          task = await publishSameIdTask();
          return verdict;
        }
      );
      try {
        expectRefused(await service.remove(ROOT_ID, true), "share this id");
      } finally {
        guard.mockRestore();
      }
      expect(physical.deleted).toEqual([]);
      expect(rowsWithId(ROOT_ID).map((entry) => entry.path)).toEqual([remote.path, task!.path]);
      expect(await exists(path.join(remote.path, "WORK.md"))).toBe(true);
      expect(await exists(path.join(sessionDir(ROOT_ID), "chat.jsonl"))).toBe(true);
    });

    test("the remote deletion runs without the registration lock; a same-id row published meanwhile refuses the id-keyed tail", async () => {
      const remote = row("remote", ROOT_ID, { runtimeConfig: remoteRuntime() });
      await seed([row("other", "root-ws-other"), remote]);
      let task: Workspace | undefined;
      let lockFreeDuringDeletion = false;
      deleteBarrier = async () => {
        // A producer takes the lock while the (slow) remote deletion runs and publishes.
        const release = await acquireRegistrationLock(1_000);
        lockFreeDuringDeletion = true;
        task = await publishSameIdTask();
        await release();
      };

      const refused = await service.remove(ROOT_ID, true);
      expectRefused(refused, "share this id");
      expectRefused(refused, "remote checkout was already deleted");
      expect(lockFreeDuringDeletion).toBe(true);
      // The remote checkout is gone, but nothing keyed by the id was touched.
      expect(physical.deleted).toEqual([remote.path]);
      expect(rowsWithId(ROOT_ID).map((entry) => entry.path)).toEqual([remote.path, task!.path]);
      expect(await exists(path.join(sessionDir(ROOT_ID), "chat.jsonl"))).toBe(true);
      // Released on refusal.
      const release = await acquireRegistrationLock(1_000);
      await release();
    });

    test("an off-host root rename holds the registration lock across its remote move and config rewrite", async () => {
      const remote = row("remote", ROOT_ID, { runtimeConfig: remoteRuntime() });
      await seed([row("other", "root-ws-other"), remote]);
      let duringMove: string | undefined;
      renameBarrier = async () => {
        try {
          const release = await acquireRegistrationLock(300);
          await release();
          duringMove = "acquired";
        } catch (error) {
          duringMove = error instanceof Error ? error.message : String(error);
        }
      };

      expect(await service.rename(ROOT_ID, "remote-renamed")).toMatchObject({ success: true });
      expect(duringMove).toBe("registration lock busy");
      expect(rowsWithId(ROOT_ID)).toHaveLength(1);
      const release = await acquireRegistrationLock(1_000);
      await release();
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

    test("a task row sharing the root's id published under the lock makes the removal ambiguous: refused under the lock", async () => {
      const root = row("root", ROOT_ID);
      await seed([root]);
      const releasePublication = await acquireRegistrationLock(5_000);
      const removal = service.remove(ROOT_ID, true);
      await new Promise((resolve) => setTimeout(resolve, 150));
      // Disjoint checkout: only the id ties it to the root, so no alias scan would refuse.
      const task = taskRow("agent_dup", ROOT_ID);
      await fsPromises.mkdir(task.path, { recursive: true });
      await config.editConfig((cfg) => {
        cfg.projects.get(projectPath)!.workspaces.push(task);
        return cfg;
      });
      await releasePublication();

      expectRefused(await removal, "share this id");
      await expectIntact(root);
      expect(
        config
          .loadConfigOrDefault()
          .projects.get(projectPath)!
          .workspaces.filter((entry) => entry.id === ROOT_ID)
      ).toHaveLength(2);
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
