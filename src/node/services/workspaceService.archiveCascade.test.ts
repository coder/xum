import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import * as path from "path";

import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import { Err, Ok } from "@/common/types/result";
import { FORCED_ARCHIVE_SUBAGENT_CHANGED_REFUSAL } from "@/node/services/forcedArchiveLoss";
import { HistoryService } from "@/node/services/historyService";
import type { TaskService } from "@/node/services/taskService";
import {
  createTaskServiceStack,
  createTestConfig,
  createTestProject,
  findWorkspaceInConfig,
  saveWorkspaces,
  testTaskSettings,
  workspaceTurnManagerFor,
  workspaceTurnManagerInternals,
  workspaceTurnRecord,
} from "@/node/services/taskService.testHarness";
import type { WorkspaceHost } from "@/node/services/taskWorkspaceSeam";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import type { WorkspaceService } from "@/node/services/workspaceService";
import {
  createMockAIService,
  createWorkspaceServiceForTest,
} from "@/node/services/workspaceService.testHarness";
import { workspaceUseLeasesFor, type WorkspaceUseLease } from "@/node/services/workspaceUseLeases";
import { WorkspaceLifecycleHooks } from "@/node/services/workspaceLifecycleHooks";
import { createWorktreeArchiveHook } from "@/node/runtime/worktreeLifecycleHooks";
import type { WorktreeArchiveBehavior } from "@/common/config/worktreeArchiveBehavior";
import { WorktreeArchiveSnapshotService } from "@/node/services/worktreeArchiveSnapshotService";

// #4477: archiving a parent archives its sub-agent tree with the parent's worktree archive
// behavior. A keep-mode archive must never delete a checkout, and a busy descendant (in either
// backend) refuses the whole archive.

// Real git worktrees and real snapshot captures: one test takes seconds, and more than bun's 5 s
// default on a loaded host.
setDefaultTimeout(60_000);

const rootId = "root-archive";
const childId = "child-archive";
const grandchildId = "grandchild-archive";

const exists = (p: string) =>
  fsPromises.access(p).then(
    () => true,
    () => false
  );

interface Backend {
  config: Config;
  workspaceService: WorkspaceService;
  taskService: TaskService;
}

function createBackend(config: Config, historyService: HistoryService): Backend {
  // Metadata is answered from this backend's Config, as AIService does.
  const aiService = createMockAIService({
    getWorkspaceMetadata: mock(async (workspaceId: string) => {
      const metadata = await config.getWorkspaceMetadataById(workspaceId);
      return metadata ? Ok(metadata) : Err(`Workspace metadata not found for ${workspaceId}`);
    }),
  });
  const workspaceService = createWorkspaceServiceForTest({ config, historyService, aiService });
  const { taskService } = createTaskServiceStack(config, {
    historyService,
    workspaceService: workspaceService as unknown as WorkspaceHost,
  });
  // The production after-archive hook: it deletes a managed checkout when the behavior says so.
  const hooks = new WorkspaceLifecycleHooks();
  hooks.registerAfterArchive(
    createWorktreeArchiveHook({ getWorktreeArchiveBehavior: () => "keep" })
  );
  workspaceService.setWorkspaceLifecycleHooks(hooks);
  workspaceService.setAgentTaskIntegration(
    taskService as unknown as Parameters<WorkspaceService["setAgentTaskIntegration"]>[0]
  );
  return { config, workspaceService, taskService };
}

describe("parent archive cascades over its sub-agent tree across two backends", () => {
  let cleanupFixture: () => Promise<void>;
  let a: Backend;
  let b: Backend;
  const checkouts = new Map<string, string>();
  const leases: WorkspaceUseLease[] = [];

  beforeEach(async () => {
    const fixture = await createTestHistoryService();
    cleanupFixture = fixture.cleanup;
    const projectPath = await createTestProject(fixture.tempDir, "repo");
    const srcBaseDir = path.join(fixture.tempDir, "src");
    // Real git worktrees: the assertions read the disk, not a runtime stub.
    const row = (id: string, extra: Partial<WorkspaceConfigEntry> = {}): WorkspaceConfigEntry => {
      const checkout = path.join(srcBaseDir, "repo", id);
      execFileSync("git", ["worktree", "add", "-q", "-b", id, checkout], { cwd: projectPath });
      checkouts.set(id, checkout);
      return {
        id,
        name: id,
        path: checkout,
        runtimeConfig: { type: "worktree", srcBaseDir },
        ...extra,
      };
    };
    const task = (parentWorkspaceId: string): Partial<WorkspaceConfigEntry> => ({
      parentWorkspaceId,
      agentType: "explore",
      agentId: "explore",
      taskStatus: "reported",
      taskModelString: "openai:gpt-5.2",
    });
    await saveWorkspaces(
      fixture.config,
      projectPath,
      [row(rootId), row(childId, task(rootId)), row(grandchildId, task(childId))],
      testTaskSettings()
    );
    a = createBackend(fixture.config, fixture.historyService);
    const configB = await createTestConfig(fixture.tempDir);
    b = createBackend(configB, new HistoryService(configB));
  });

  afterEach(async () => {
    for (const lease of leases.splice(0)) await lease.release();
    checkouts.clear();
    mock.restore();
    await cleanupFixture();
  });

  const allIds = [rootId, childId, grandchildId];

  async function setArchiveBehavior(behavior: WorktreeArchiveBehavior): Promise<void> {
    await a.config.editConfig((config) => ({ ...config, worktreeArchiveBehavior: behavior }));
  }

  test("a keep-mode archive archives the whole tree and never deletes a checkout", async () => {
    await setArchiveBehavior("keep");

    const result = await a.workspaceService.archive(rootId);

    expect(result).toEqual({ success: true, data: { kind: "archived" } });
    for (const id of allIds) {
      expect(findWorkspaceInConfig(b.config, id)?.archivedAt).toBeDefined();
      expect(await exists(checkouts.get(id)!)).toBe(true);
    }
  });

  test.each([null, childId, rootId])(
    "archiving a tree discards only archived owners' side chats (refused owner: %s)",
    async (refusedId) => {
      await setArchiveBehavior("keep");
      const sideChatIds = new Map<string, string>();
      for (const ownerId of allIds) {
        const side = await a.workspaceService.createSideChat(ownerId);
        if (!side.success) throw new Error(side.error);
        sideChatIds.set(ownerId, side.data.metadata.id);
      }
      if (refusedId != null) {
        const hooks = new WorkspaceLifecycleHooks();
        hooks.registerBeforeArchive(({ workspaceId }) =>
          Promise.resolve(workspaceId === refusedId ? Err("archive refused") : Ok(undefined))
        );
        a.workspaceService.setWorkspaceLifecycleHooks(hooks);
      }

      const result = await a.workspaceService.archive(rootId);
      expect(result.success).toBe(refusedId == null);

      // The cascade is deepest-first. A later refusal must still clean up the successful
      // descendants, while keeping the failed/skipped owners' side chats available.
      const archivedIds =
        refusedId === childId
          ? [grandchildId]
          : refusedId === rootId
            ? [childId, grandchildId]
            : allIds;
      for (const ownerId of allIds) {
        const archived = archivedIds.includes(ownerId);
        expect(findWorkspaceInConfig(b.config, ownerId)?.archivedAt != null).toBe(archived);
        expect(await exists(checkouts.get(ownerId)!)).toBe(true);
        const sideId = sideChatIds.get(ownerId)!;
        expect(b.config.findWorkspace(sideId) == null).toBe(archived);
        expect(await exists(path.join(b.config.sessionsDir, sideId))).toBe(!archived);
      }
    }
  );

  test("a delete-mode archive refuses while the other backend uses a descendant, archiving nothing", async () => {
    await setArchiveBehavior("delete");
    leases.push(await workspaceUseLeasesFor(b.config).hold(childId, "terminal"));

    const result = await a.workspaceService.archive(rootId);

    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error).toContain(childId);
    expect(result.success ? "" : result.error).toContain("in use by another Xum process");
    for (const id of allIds) {
      expect(findWorkspaceInConfig(a.config, id)?.archivedAt).toBeUndefined();
      expect(await exists(checkouts.get(id)!)).toBe(true);
    }
  });

  test("a parentWorkspaceId cycle gets the single-workspace archive's answer instead of a thrown error", async () => {
    await setArchiveBehavior("keep");
    await a.config.editConfig((config) => {
      const row = [...config.projects.values()][0].workspaces.find((w) => w.id === rootId)!;
      row.parentWorkspaceId = grandchildId;
      return config;
    });

    // Listing the tree throws on the cycle; the archive falls back to the workspace alone,
    // whose own descendant check refuses this malformed tree with a normal Result.
    const result = await a.workspaceService.archive(rootId);

    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error).toContain("active descendant sub-agents");
    for (const id of allIds) {
      expect(findWorkspaceInConfig(a.config, id)?.archivedAt).toBeUndefined();
    }
  });

  // #4930: the model-facing archive (task_workspace_lifecycle) cascades like the user's archive,
  // keeping its lossy-removal contract: it refuses with the at-risk paths, never with an ack.
  const ownerId = "owner-archive";

  async function modelArchiveRoot(options?: { force?: boolean }) {
    await workspaceTurnManagerInternals(a.taskService).taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(ownerId, rootId, "wst_root", "completed", { createdWorkspace: true })
    );
    return await workspaceTurnManagerFor(a.taskService).archiveOwnedWorkspaceTurnWorkspace(
      ownerId,
      { workspaceId: rootId },
      options
    );
  }

  test("a model-facing archive archives the parent's inactive sub-agents with it", async () => {
    await setArchiveBehavior("keep");

    const result = await modelArchiveRoot();

    expect(result.success && result.data.status).toBe("archived");
    for (const id of allIds) {
      expect(findWorkspaceInConfig(b.config, id)?.archivedAt).toBeDefined();
      expect(await exists(checkouts.get(id)!)).toBe(true);
    }
  });

  test("a model-facing archive refuses while a sub-agent is active, archiving nothing", async () => {
    await setArchiveBehavior("keep");
    await a.config.editConfig((config) => {
      const row = [...config.projects.values()][0].workspaces.find((w) => w.id === grandchildId)!;
      row.taskStatus = "running";
      return config;
    });

    const result = await modelArchiveRoot();

    expect(result.success && result.data.status).toBe("error");
    expect(result.success ? result.data.error : "").toContain("active descendant sub-agents");
    for (const id of allIds) {
      expect(findWorkspaceInConfig(a.config, id)?.archivedAt).toBeUndefined();
    }
  });

  test("a model-facing snapshot archive refuses with a sub-agent's untracked paths, archiving nothing", async () => {
    await setArchiveBehavior("snapshot");
    a.workspaceService.setWorktreeArchiveSnapshotService(
      new WorktreeArchiveSnapshotService(a.config)
    );
    await fsPromises.writeFile(path.join(checkouts.get(grandchildId)!, "notes.txt"), "unsaved\n");

    const result = await modelArchiveRoot();

    assert(result.success, "the lifecycle archive returns a result");
    expect(result.data.status).toBe("error");
    expect(result.data.paths).toEqual([`${grandchildId}: notes.txt`]);
    expect(result.data.error).toContain(grandchildId);
    for (const id of allIds) {
      expect(findWorkspaceInConfig(a.config, id)?.archivedAt).toBeUndefined();
      expect(await exists(checkouts.get(id)!)).toBe(true);
    }
    expect(await exists(path.join(checkouts.get(grandchildId)!, "notes.txt"))).toBe(true);
  });

  test("a model-facing snapshot archive refuses with the parent's own untracked paths before archiving its sub-agents", async () => {
    await setArchiveBehavior("snapshot");
    a.workspaceService.setWorktreeArchiveSnapshotService(
      new WorktreeArchiveSnapshotService(a.config)
    );
    await fsPromises.writeFile(path.join(checkouts.get(rootId)!, "notes.txt"), "unsaved\n");

    const result = await modelArchiveRoot();

    assert(result.success, "the lifecycle archive returns a result");
    expect(result.data.status).toBe("error");
    expect(result.data.paths).toEqual(["notes.txt"]);
    for (const id of allIds) {
      expect(findWorkspaceInConfig(a.config, id)?.archivedAt).toBeUndefined();
    }
  });

  // `force` lets the model-facing archive delete what it otherwise refuses to lose. It lists
  // the files itself under the locks, deletes exactly those and reports them.
  async function enableSnapshotArchive(): Promise<void> {
    await setArchiveBehavior("snapshot");
    a.workspaceService.setWorktreeArchiveSnapshotService(
      new WorktreeArchiveSnapshotService(a.config)
    );
  }

  test("a forced model-facing snapshot archive deletes the parent's and the sub-agent's untracked files and reports them", async () => {
    await enableSnapshotArchive();
    await fsPromises.writeFile(path.join(checkouts.get(rootId)!, "notes.txt"), "unsaved\n");
    await fsPromises.writeFile(path.join(checkouts.get(grandchildId)!, "notes.txt"), "unsaved\n");

    const result = await modelArchiveRoot({ force: true });

    assert(result.success, "the lifecycle archive returns a result");
    expect(result.data.status).toBe("archived");
    expect(result.data.paths).toEqual(["notes.txt", `${grandchildId}: notes.txt`]);
    expect(result.data.note).toBeDefined();
    for (const id of allIds) {
      expect(findWorkspaceInConfig(b.config, id)?.archivedAt).toBeDefined();
      // The snapshot archive removes the checkout: the reported files are really gone.
      expect(await exists(path.join(checkouts.get(id)!, "notes.txt"))).toBe(false);
    }
  });

  test("a forced model-facing archive does not delete a sub-agent file that appeared after it listed the files", async () => {
    await enableSnapshotArchive();
    const checkout = checkouts.get(grandchildId)!;
    await fsPromises.writeFile(path.join(checkout, "notes.txt"), "unsaved\n");
    // The file lands after the forced archive's last listing, which it makes right before the
    // sink (the target is listed twice per listing, so this is its fourth listing): only the
    // sink's own acknowledgement check can still stop it.
    const preflightArchive = a.workspaceService.preflightArchive.bind(a.workspaceService);
    let targetListings = 0;
    let wroteLateFile = false;
    spyOn(a.workspaceService, "preflightArchive").mockImplementation(async (id, options) => {
      const listed = await preflightArchive(id, options);
      if (id === rootId && (targetListings += 1) === 4) {
        wroteLateFile = true;
        await fsPromises.writeFile(path.join(checkout, "late.txt"), "written after the listing\n");
      }
      return listed;
    });

    const result = await modelArchiveRoot({ force: true });

    assert(result.success, "the lifecycle archive returns a result");
    expect(result.data.status).toBe("error");
    expect(result.data.error).toContain(grandchildId);
    // No dialog to retry in: the refusal tells the agent to find out what writes there.
    expect(result.data.error).toContain(FORCED_ARCHIVE_SUBAGENT_CHANGED_REFUSAL);
    expect(wroteLateFile).toBe(true);
    for (const id of allIds) {
      expect(findWorkspaceInConfig(a.config, id)?.archivedAt).toBeUndefined();
      expect(await exists(checkouts.get(id)!)).toBe(true);
    }
    expect(await exists(path.join(checkout, "late.txt"))).toBe(true);
    expect(await exists(path.join(checkout, "notes.txt"))).toBe(true);
  });

  test("a forced model-facing archive under the delete policy deletes the tree's checkouts and names them, while an unforced one refuses", async () => {
    await setArchiveBehavior("delete");

    const unforced = await modelArchiveRoot();

    assert(unforced.success, "the lifecycle archive returns a result");
    expect(unforced.data.status).toBe("error");
    for (const id of allIds) {
      expect(findWorkspaceInConfig(a.config, id)?.archivedAt).toBeUndefined();
      expect(await exists(checkouts.get(id)!)).toBe(true);
    }

    const forced = await modelArchiveRoot({ force: true });

    assert(forced.success, "the lifecycle archive returns a result");
    expect(forced.data.status).toBe("archived");
    expect(forced.data.note).toContain(checkouts.get(rootId));
    expect(forced.data.note).toContain(childId);
    expect(forced.data.note).toContain(grandchildId);
    for (const id of allIds) {
      expect(findWorkspaceInConfig(b.config, id)?.archivedAt).toBeDefined();
      expect(await exists(checkouts.get(id)!)).toBe(false);
    }
  });

  test("a forced archive under the delete policy refuses a sub-agent that appeared after it listed the checkouts", async () => {
    await setArchiveBehavior("delete");
    // The grandchild is not part of the tree yet: another backend creates it under the child
    // after the forced archive listed the tree, before the archive fences sub-agent creation.
    await a.config.editConfig((config) => {
      const row = [...config.projects.values()][0].workspaces.find((w) => w.id === grandchildId)!;
      delete row.parentWorkspaceId;
      return config;
    });
    // After the forced archive's last listing (the target's fourth), before the sink fences
    // sub-agent creation: only the sink's allowlist can still stop it.
    const preflightArchive = a.workspaceService.preflightArchive.bind(a.workspaceService);
    let targetListings = 0;
    spyOn(a.workspaceService, "preflightArchive").mockImplementation(async (id, options) => {
      const listed = await preflightArchive(id, options);
      if (id === rootId && (targetListings += 1) === 4) {
        await a.config.editConfig((config) => {
          const row = [...config.projects.values()][0].workspaces.find(
            (w) => w.id === grandchildId
          )!;
          row.parentWorkspaceId = childId;
          return config;
        });
      }
      return listed;
    });

    const result = await modelArchiveRoot({ force: true });

    assert(result.success, "the lifecycle archive returns a result");
    expect(result.data.status).toBe("error");
    expect(result.data.error).toContain(grandchildId);
    // Its checkout was never in the forced list, so it is neither archived nor deleted.
    expect(findWorkspaceInConfig(a.config, grandchildId)?.archivedAt).toBeUndefined();
    expect(await exists(checkouts.get(grandchildId)!)).toBe(true);
  });

  // A forced archive cascades over the sub-agents deepest-first, and what it deletes with them
  // cannot be undone. A refusal that is already known must come before anything is archived.
  const forcedPolicies = [
    ["the delete policy", "delete"],
    ["the snapshot policy", "snapshot"],
  ] as const;

  async function setUpForcedPolicy(policy: "delete" | "snapshot"): Promise<void> {
    if (policy === "snapshot") await enableSnapshotArchive();
    else await setArchiveBehavior("delete");
    // The deepest sub-agent holds a file that the snapshot policy cannot keep.
    await fsPromises.writeFile(path.join(checkouts.get(grandchildId)!, "gc-notes.txt"), "x\n");
  }

  async function expectNothingArchivedOrDeleted(): Promise<void> {
    for (const id of allIds) {
      expect(findWorkspaceInConfig(a.config, id)?.archivedAt).toBeUndefined();
      expect(await exists(checkouts.get(id)!)).toBe(true);
    }
    expect(await exists(path.join(checkouts.get(grandchildId)!, "gc-notes.txt"))).toBe(true);
  }

  test.each(forcedPolicies)(
    "a forced archive under %s refuses before it archives anything when a middle sub-agent has an external editor or terminal open",
    async (_name, policy) => {
      await setUpForcedPolicy(policy);
      spyOn(a.workspaceService, "hasUntrackableExternalAppOpen").mockImplementation((id) =>
        Promise.resolve(id === childId)
      );

      const result = await modelArchiveRoot({ force: true });

      assert(result.success, "the lifecycle archive returns a result");
      expect(result.data.status).toBe("error");
      expect(result.data.error).toContain(childId);
      expect(result.data.error).toContain("native terminal or external editor");
      await expectNothingArchivedOrDeleted();
    }
  );

  test.each(forcedPolicies)(
    "a forced archive under %s refuses before it archives anything while a sub-agent has a terminal open",
    async (_name, policy) => {
      await setUpForcedPolicy(policy);
      const listLive = a.workspaceService.listLiveWorkspaceActivity.bind(a.workspaceService);
      spyOn(a.workspaceService, "listLiveWorkspaceActivity").mockImplementation((id) => ({
        ...listLive(id),
        terminalSessions: id === childId,
      }));

      const result = await modelArchiveRoot({ force: true });

      assert(result.success, "the lifecycle archive returns a result");
      expect(result.data.status).toBe("error");
      expect(result.data.error).toContain(childId);
      expect(result.data.error).toContain("open terminal sessions");
      await expectNothingArchivedOrDeleted();
    }
  );

  test("a forced archive refuses before it archives anything while a sub-agent runs background bash", async () => {
    await setUpForcedPolicy("delete");
    // Both signals see the process: the refusal still names it once.
    spyOn(a.workspaceService, "hasRunningBackgroundBashProcesses").mockImplementation((id) =>
      Promise.resolve(id === childId)
    );
    const listLive = a.workspaceService.listLiveWorkspaceActivity.bind(a.workspaceService);
    spyOn(a.workspaceService, "listLiveWorkspaceActivity").mockImplementation((id) => ({
      ...listLive(id),
      backgroundBashProcesses: id === childId,
    }));

    const result = await modelArchiveRoot({ force: true });

    assert(result.success, "the lifecycle archive returns a result");
    expect(result.data.status).toBe("error");
    expect(result.data.error).toContain("running background bash processes");
    expect(result.data.error?.match(/running background bash processes/g)).toHaveLength(1);
    await expectNothingArchivedOrDeleted();
  });

  test.each(forcedPolicies)(
    "a forced archive under %s refuses before it archives anything while a sub-agent owns an active workflow run",
    async (_name, policy) => {
      await setUpForcedPolicy(policy);
      spyOn(a.taskService, "hasActiveTopLevelWorkflowRunsForWorkspace").mockImplementation((id) =>
        Promise.resolve(id === childId)
      );

      const result = await modelArchiveRoot({ force: true });

      assert(result.success, "the lifecycle archive returns a result");
      expect(result.data.status).toBe("error");
      expect(result.data.error).toContain(childId);
      expect(result.data.error).toContain("workflow run");
      await expectNothingArchivedOrDeleted();
    }
  );

  test("a forced snapshot archive refuses before it archives anything when the target's files changed after the listing", async () => {
    await setUpForcedPolicy("snapshot");
    const rootCheckout = checkouts.get(rootId)!;
    const preflightArchive = a.workspaceService.preflightArchive.bind(a.workspaceService);
    let listings = 0;
    spyOn(a.workspaceService, "preflightArchive").mockImplementation(async (id, options) => {
      const listed = await preflightArchive(id, options);
      // The target's second listing is the forced archive's own: the file lands right after it.
      if (id === rootId && (listings += 1) === 2) {
        await fsPromises.writeFile(path.join(rootCheckout, "late.txt"), "written after\n");
      }
      return listed;
    });

    const result = await modelArchiveRoot({ force: true });

    assert(result.success, "the lifecycle archive returns a result");
    expect(result.data.status).toBe("error");
    expect(result.data.paths).toContain("late.txt");
    await expectNothingArchivedOrDeleted();
    expect(await exists(path.join(rootCheckout, "late.txt"))).toBe(true);
  });

  // What no listing can see: the refusal only comes at the sink, after the deeper sub-agents
  // were archived. The failure result must then say what they lost.
  function flipOnNthCall(id: string, call: number, onCall?: () => Promise<void>) {
    let calls = 0;
    spyOn(a.workspaceService, "hasUntrackableExternalAppOpen").mockImplementation(
      async (askedId) => {
        if (askedId !== id) return false;
        calls += 1;
        if (calls === call) await onCall?.();
        return onCall == null && calls >= call;
      }
    );
  }

  test.each(forcedPolicies)(
    "a forced archive under %s whose middle sub-agent refuses at the sink reports what the archived sub-agent lost",
    async (_name, policy) => {
      await setUpForcedPolicy(policy);
      // Calls 1 and 2 are the listing and the second listing: the marker appears after them.
      flipOnNthCall(childId, 3);

      const result = await modelArchiveRoot({ force: true });

      assert(result.success, "the lifecycle archive returns a result");
      expect(result.data.status).toBe("error");
      expect(result.data.error).toContain(childId);
      // The deepest sub-agent was archived first, and lost what the policy deletes.
      expect(findWorkspaceInConfig(a.config, grandchildId)?.archivedAt).toBeDefined();
      expect(await exists(checkouts.get(grandchildId)!)).toBe(false);
      expect(findWorkspaceInConfig(a.config, childId)?.archivedAt).toBeUndefined();
      expect(await exists(checkouts.get(childId)!)).toBe(true);
      expect(result.data.note).toContain(grandchildId);
      if (policy === "delete") expect(result.data.note).toContain(`branch ${grandchildId}`);
      else expect(result.data.note).toContain(`${grandchildId}: gc-notes.txt`);
      expect(result.data.note).not.toMatch(/\bchild-archive\b/);
    }
  );

  test("a forced snapshot archive whose target's files change during the cascade reports what the archived sub-agent lost", async () => {
    await setUpForcedPolicy("snapshot");
    const rootCheckout = checkouts.get(rootId)!;
    // Call 1 is the lifecycle manager's early check. Call 2 is the sink's, after the sub-agents.
    flipOnNthCall(rootId, 2, () =>
      fsPromises.writeFile(path.join(rootCheckout, "late.txt"), "written during the cascade\n")
    );

    const result = await modelArchiveRoot({ force: true });

    assert(result.success, "the lifecycle archive returns a result");
    expect(result.data.status).toBe("error");
    expect(result.data.paths).toContain("late.txt");
    expect(findWorkspaceInConfig(a.config, grandchildId)?.archivedAt).toBeDefined();
    expect(await exists(path.join(checkouts.get(grandchildId)!, "gc-notes.txt"))).toBe(false);
    expect(result.data.note).toContain(`${grandchildId}: gc-notes.txt`);
    expect(findWorkspaceInConfig(a.config, rootId)?.archivedAt).toBeUndefined();
    expect(await exists(path.join(rootCheckout, "late.txt"))).toBe(true);
  });

  test("a forced archive under the delete policy still refuses while an external editor or native terminal is open on a sub-agent", async () => {
    await setArchiveBehavior("delete");
    spyOn(a.workspaceService, "hasUntrackableExternalAppOpen").mockImplementation((id) =>
      Promise.resolve(id === grandchildId)
    );

    const result = await modelArchiveRoot({ force: true });

    assert(result.success, "the lifecycle archive returns a result");
    expect(result.data.status).toBe("error");
    expect(result.data.error).toContain("native terminal or external editor");
    for (const id of allIds) {
      expect(findWorkspaceInConfig(a.config, id)?.archivedAt).toBeUndefined();
      expect(await exists(checkouts.get(id)!)).toBe(true);
    }
  });

  test("the sink refuses a delete-policy archive that a forcing caller allowed while an external app is open", async () => {
    await setArchiveBehavior("delete");
    spyOn(a.workspaceService, "hasUntrackableExternalAppOpen").mockResolvedValue(true);

    // The caller's own early check is bypassed here: only the sink's recheck stands.
    const result = await a.workspaceService.archiveWhileTaskTreeLocked(grandchildId, undefined, {
      forbidWorktreeCheckoutDeletion: false,
      refuseLiveUserActivity: true,
      worktreeArchiveBehaviorOverride: "delete",
    });

    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error).toContain("native terminal or external editor");
    expect(findWorkspaceInConfig(a.config, grandchildId)?.archivedAt).toBeUndefined();
    expect(await exists(checkouts.get(grandchildId)!)).toBe(true);
  });

  test("the cascade preflight does not list a sub-agent whose checkout the delete policy leaves alone", async () => {
    await a.config.editConfig((config) => {
      const row = [...config.projects.values()][0].workspaces.find((w) => w.id === childId)!;
      // Not a managed worktree: the worktree archive hook skips it.
      row.runtimeConfig = { type: "local" };
      return config;
    });

    const allowed = await a.workspaceService.preflightArchiveCascade(rootId, "delete", {
      forced: true,
    });

    assert(allowed.success, "an allowed cascade preflight lists the checkouts");
    expect(allowed.data.deletedCheckouts?.map((subagent) => subagent.workspaceId)).toEqual([
      grandchildId,
    ]);
  });

  test("the cascade preflight lists the sub-agent checkouts the delete policy would delete only for a caller that allows it", async () => {
    const refused = await a.workspaceService.preflightArchiveCascade(rootId, "delete");
    const allowed = await a.workspaceService.preflightArchiveCascade(rootId, "delete", {
      forced: true,
    });

    expect(refused.success).toBe(false);
    assert(allowed.success, "an allowed cascade preflight lists the checkouts");
    expect(allowed.data.deletedCheckouts?.map((subagent) => subagent.workspaceId).sort()).toEqual(
      [childId, grandchildId].sort()
    );
  });

  // The user's archive confirms a sub-agent's lossy files in the parent's dialog instead of
  // refusing with no way forward.
  test("a user snapshot archive confirms a sub-agent's untracked files, then archives the tree", async () => {
    await setArchiveBehavior("snapshot");
    a.workspaceService.setWorktreeArchiveSnapshotService(
      new WorktreeArchiveSnapshotService(a.config)
    );
    const notes = path.join(checkouts.get(grandchildId)!, "notes.txt");
    await fsPromises.writeFile(notes, "unsaved\n");

    const preflight = await a.workspaceService.preflightArchiveWithSubagents(rootId);
    assert(preflight.success, "the preflight returns a result");
    assert(
      preflight.data.kind === "confirm-lossy-untracked-files",
      "the preflight asks to confirm"
    );
    expect(preflight.data.paths).toEqual([]);
    expect(
      preflight.data.subagents?.map((subagent) => [subagent.workspaceId, subagent.paths])
    ).toEqual([[grandchildId, ["notes.txt"]]]);

    const unconfirmed = await a.workspaceService.archive(rootId);
    expect(unconfirmed.success).toBe(false);
    for (const id of allIds) {
      expect(findWorkspaceInConfig(a.config, id)?.archivedAt).toBeUndefined();
    }

    const result = await a.workspaceService.archive(rootId, preflight.data.paths, {
      acknowledgedSubagentUntrackedPaths: { [grandchildId]: ["notes.txt"] },
    });

    expect(result).toEqual({ success: true, data: { kind: "archived" } });
    for (const id of allIds) {
      expect(findWorkspaceInConfig(b.config, id)?.archivedAt).toBeDefined();
    }
  });

  test("a user snapshot archive refuses a sub-agent file created after the confirmation", async () => {
    await setArchiveBehavior("snapshot");
    a.workspaceService.setWorktreeArchiveSnapshotService(
      new WorktreeArchiveSnapshotService(a.config)
    );
    await fsPromises.writeFile(path.join(checkouts.get(grandchildId)!, "notes.txt"), "unsaved\n");
    await fsPromises.writeFile(path.join(checkouts.get(grandchildId)!, "later.txt"), "new\n");

    const result = await a.workspaceService.archive(rootId, [], {
      acknowledgedSubagentUntrackedPaths: { [grandchildId]: ["notes.txt"] },
    });

    assert(!result.success, "the archive refuses the file created after the confirmation");
    // The dialog's retry lists the file again: only the user's archive says so.
    expect(result.error).toContain("archive again to review them");
    expect(result.error).not.toContain(FORCED_ARCHIVE_SUBAGENT_CHANGED_REFUSAL);
    for (const id of allIds) {
      expect(findWorkspaceInConfig(a.config, id)?.archivedAt).toBeUndefined();
    }
    expect(await exists(path.join(checkouts.get(grandchildId)!, "later.txt"))).toBe(true);
  });

  test("a delete-mode archive of an idle tree archives every row and deletes every checkout", async () => {
    await setArchiveBehavior("delete");

    const result = await a.workspaceService.archive(rootId);

    expect(result).toEqual({ success: true, data: { kind: "archived" } });
    for (const id of allIds) {
      expect(findWorkspaceInConfig(b.config, id)?.archivedAt).toBeDefined();
      expect(await exists(checkouts.get(id)!)).toBe(false);
    }
  });
});
