import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { execFileSync } from "child_process";
import cjsFs from "fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { Result } from "@/common/types/result";
import type { ExperimentsService } from "./experimentsService";
import { WorkspaceGoalService } from "./workspaceGoalService";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import { RuntimeError } from "@/node/runtime/Runtime";
import * as runtimeHelpers from "@/node/utils/runtime/helpers";
import type { InitStateManager } from "./initStateManager";
import { WorkspaceUseLeases, type WorkspaceUseLease } from "./workspaceUseLeases";
import type { WorkspaceService } from "./workspaceService";
import {
  createWorkspaceServiceHarness,
  type WorkspaceServiceHarness,
} from "./workspaceService.testHarness";

/**
 * #4745/#4779: when the registration config edit rejects, create, fork and rename must undo what
 * they made on disk and in memory, return the original error, and leave the next attempt
 * unobstructed.
 * Real Config, real git worktrees; only the rename that publishes config.json fails (#4752).
 */
function failConfigPublish(options: { corruptConfig?: boolean } = {}) {
  const realRename = cjsFs.rename.bind(cjsFs);
  return spyOn(cjsFs, "rename").mockImplementation(((
    from: cjsFs.PathLike,
    to: cjsFs.PathLike,
    callback: cjsFs.NoParamCallback
  ) => {
    if (path.basename(String(to)) === "config.json") {
      if (options.corruptConfig) cjsFs.writeFileSync(String(to), "{ not json");
      callback(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }));
      return;
    }
    realRename(from, to, callback);
  }) as typeof cjsFs.rename);
}

/** Runs `fn` while the config.json publish fails; it must fail with that save error. */
async function expectFailsWithSaveError(fn: () => Promise<Result<unknown>>): Promise<void> {
  const publish = failConfigPublish();
  const result = await fn().finally(() => publish.mockRestore());
  expect(result.success).toBe(false);
  expect(result.success ? "" : result.error).toContain("EACCES");
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function initRepo(repoPath: string): Promise<void> {
  await fs.mkdir(repoPath, { recursive: true });
  git(repoPath, "init", "-b", "main");
  git(repoPath, "config", "user.email", "test@example.com");
  git(repoPath, "config", "user.name", "Test");
  await fs.writeFile(path.join(repoPath, "README.md"), "hello\n");
  git(repoPath, "add", ".");
  git(repoPath, "commit", "-m", "init");
}

function worktreePaths(repoPath: string): string[] {
  return git(repoPath, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .sort();
}

/** Creates `branch` one commit ahead of HEAD, so only `git branch -D` would delete it. */
function branchWithOwnCommit(repoPath: string, branch: string): string {
  const tip = git(repoPath, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", `${branch} work`);
  git(repoPath, "branch", branch, tip);
  return tip;
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false
  );
}

describe("WorkspaceService registration rollback (#4745)", () => {
  let harness: WorkspaceServiceHarness;
  let service: WorkspaceService;
  let initStateManager: InitStateManager;
  let projectPath: string;
  let otherProjectPath: string;
  let srcBaseDir: string;

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness({
      experimentsService: {
        isExperimentEnabled: (id: string) => id === EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES,
      } as unknown as ExperimentsService,
    });
    service = harness.service;
    initStateManager = harness.initStateManager;
    projectPath = path.join(harness.rootDir, "project");
    otherProjectPath = path.join(harness.rootDir, "other");
    srcBaseDir = path.join(harness.rootDir, "src");
    await initRepo(projectPath);
    await initRepo(otherProjectPath);
    await harness.config.editConfig((cfg) => {
      cfg.projects.set(projectPath, { workspaces: [], trusted: true });
      cfg.projects.set(otherProjectPath, { workspaces: [], trusted: true });
      return cfg;
    });
    // The init hook is not under test and would keep running against the checkout.
    spyOn(runtimeFactory, "runBackgroundInit").mockResolvedValue(undefined);
  });

  afterEach(async () => {
    // Let deferred checkouts of successful retries finish before the temp root goes away.
    await Promise.all(
      (
        service as unknown as { initSettlementPromises: Map<string, Promise<void>> }
      ).initSettlementPromises.values()
    );
    mock.restore();
    await harness.cleanup();
  });

  const persistedWorkspaceIds = () =>
    [...harness.config.loadConfigOrDefault().projects.values()].flatMap((project) =>
      project.workspaces.map((workspace) => workspace.id)
    );
  const projects = () => [
    { projectPath, projectName: "project" },
    { projectPath: otherProjectPath, projectName: "other" },
  ];

  async function expectNoCreationLeftovers(workspaceId: string, name: string, repos: string[]) {
    for (const repoPath of repos) {
      expect(worktreePaths(repoPath).map((p) => path.basename(p))).not.toContain(name);
    }
    expect(persistedWorkspaceIds()).not.toContain(workspaceId);
    expect(await exists(path.join(harness.config.sessionsDir, workspaceId))).toBe(false);
    expect(initStateManager.getInitState(workspaceId)).toBeUndefined();
    const sessions = (service as unknown as { sessions: Map<string, unknown> }).sessions;
    expect(sessions.has(workspaceId)).toBe(false);
  }

  const createWorktree = (branch: string, awaitMaterialization = true) =>
    service.create(
      projectPath,
      branch,
      "main",
      undefined,
      { type: "worktree", srcBaseDir },
      undefined,
      undefined,
      undefined,
      { awaitMaterialization }
    );

  test.each([
    { label: "materialized", awaitMaterialization: true },
    { label: "deferred", awaitMaterialization: false },
  ])(
    "create ($label) removes its worktree, session and init state and keeps the save error",
    async ({ awaitMaterialization }) => {
      const workspaceId = "aaaaaaaaa1";
      spyOn(harness.config, "generateStableId").mockReturnValueOnce(workspaceId);

      await expectFailsWithSaveError(() => createWorktree("feature-a", awaitMaterialization));
      await expectNoCreationLeftovers(workspaceId, "feature-a", [projectPath]);
      expect(git(projectPath, "branch", "--list", "feature-a")).toBe("");

      // Nothing left collides with the retry: same branch, same directory name.
      expect(await createWorktree("feature-a", awaitMaterialization)).toMatchObject({
        success: true,
        data: { metadata: { name: "feature-a" } },
      });
    }
  );

  test("create removes a checkout its post-checkout hook left dirty", async () => {
    const hook = path.join(projectPath, ".git", "hooks", "post-checkout");
    await fs.writeFile(hook, "#!/bin/sh\necho generated > generated.txt\n", { mode: 0o755 });
    const workspaceId = "aaaaaaaaa2";
    spyOn(harness.config, "generateStableId").mockReturnValueOnce(workspaceId);

    await expectFailsWithSaveError(() => createWorktree("feature-hook"));
    await expectNoCreationLeftovers(workspaceId, "feature-hook", [projectPath]);
    expect(git(projectPath, "branch", "--list", "feature-hook")).toBe("");
  });

  // A merged branch is the one a rollback could lose: a plain delete runs `git branch -d`.
  test.each([
    { label: "materialized", awaitMaterialization: true },
    { label: "deferred", awaitMaterialization: false },
  ])(
    "create ($label) on an existing branch keeps that branch",
    async ({ awaitMaterialization }) => {
      git(projectPath, "branch", "existing");
      const tip = git(projectPath, "rev-parse", "existing");

      await expectFailsWithSaveError(() => createWorktree("existing", awaitMaterialization));
      expect(git(projectPath, "rev-parse", "existing")).toBe(tip);
      // Only the checkout goes (#4775), so the retry on the same branch is unobstructed.
      expect(worktreePaths(projectPath)).toHaveLength(1);
      expect((await createWorktree("existing", awaitMaterialization)).success).toBe(true);
    }
  );

  test("createMultiProject removes its worktrees, container, session and init state", async () => {
    const workspaceId = "bbbbbbbbb1";
    spyOn(harness.config, "generateStableId").mockReturnValueOnce(workspaceId);
    await expectFailsWithSaveError(() =>
      service.createMultiProject(projects(), "multi-a", "main", undefined, {
        type: "worktree",
        srcBaseDir,
      })
    );
    await expectNoCreationLeftovers(workspaceId, "multi-a", [projectPath, otherProjectPath]);
    expect(await exists(path.join(srcBaseDir, "_workspaces", "multi-a"))).toBe(false);

    const retry = await service.createMultiProject(projects(), "multi-a", "main", undefined, {
      type: "worktree",
      srcBaseDir,
    });
    expect(retry.success).toBe(true);
  });

  test("createMultiProject keeps an existing branch and removes the ones it made", async () => {
    git(projectPath, "branch", "multi-x");

    await expectFailsWithSaveError(() =>
      service.createMultiProject(projects(), "multi-x", "main", undefined, {
        type: "worktree",
        srcBaseDir,
      })
    );
    expect(git(projectPath, "branch", "--list", "multi-x")).not.toBe("");
    expect(git(otherProjectPath, "branch", "--list", "multi-x")).toBe("");
    expect(worktreePaths(projectPath)).toHaveLength(1);
    expect(worktreePaths(otherProjectPath)).toHaveLength(1);
  });

  test("fork removes its worktree and copied session, leaving the source intact", async () => {
    const source = await createWorktree("source");
    if (!source.success) throw new Error(source.error);
    const sourceId = source.data.metadata.id;
    const forkId = "ccccccccc1";
    spyOn(harness.config, "generateStableId").mockReturnValueOnce(forkId);

    await expectFailsWithSaveError(() => service.fork(sourceId, "fork-a"));
    await expectNoCreationLeftovers(forkId, "fork-a", [projectPath]);
    expect(worktreePaths(projectPath)).toHaveLength(2);
    expect(persistedWorkspaceIds()).toEqual([sourceId]);

    expect(await service.fork(sourceId, "fork-a")).toMatchObject({
      success: true,
      data: { metadata: { name: "fork-a" } },
    });
  });

  test("rename moves the checkout back and keeps the save error", async () => {
    const created = await createWorktree("before");
    if (!created.success) throw new Error(created.error);
    const { id, namedWorkspacePath: oldPath } = created.data.metadata;

    await expectFailsWithSaveError(() => service.rename(id, "after"));
    // Disk agrees with the unchanged config again: old checkout and branch, nothing new.
    expect(worktreePaths(projectPath)).toEqual(
      [await fs.realpath(projectPath), await fs.realpath(oldPath)].sort()
    );
    expect(git(oldPath, "branch", "--show-current")).toBe("before");
    expect(git(projectPath, "branch", "--list", "after")).toBe("");
    expect((await harness.config.getWorkspaceMetadataById(id))?.name).toBe("before");

    expect((await service.rename(id, "after")).success).toBe(true);
    expect((await harness.config.getWorkspaceMetadataById(id))?.name).toBe("after");
  });

  // #4826: not a registration rollback, but it needs the same real-checkout rename. The rename
  // itself has committed when the plan move runs, so a transport failure there must still publish
  // the new name and then report the stranded plan instead of claiming a clean rename.
  test("rename that cannot move the plan in transport reports it after publishing the rename", async () => {
    const created = await createWorktree("plan-before");
    if (!created.success) throw new Error(created.error);
    const { id } = created.data.metadata;
    spyOn(runtimeHelpers, "movePlanFile").mockRejectedValue(
      new RuntimeError("ssh: connect to host dev port 22: Connection refused", "network")
    );
    const emittedNames: string[] = [];
    service.on("metadata", (event: { workspaceId: string; metadata: { name: string } | null }) => {
      if (event.workspaceId === id && event.metadata) emittedNames.push(event.metadata.name);
    });

    const result = await service.rename(id, "plan-after");

    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error).toContain("Connection refused");
    expect((await harness.config.getWorkspaceMetadataById(id))?.name).toBe("plan-after");
    expect(emittedNames).toContain("plan-after");
  });

  test("multi-project rename moves every checkout and the container back", async () => {
    const created = await service.createMultiProject(
      projects(),
      "multi-before",
      "main",
      undefined,
      {
        type: "worktree",
        srcBaseDir,
      }
    );
    if (!created.success) throw new Error(created.error);
    const { id, namedWorkspacePath: oldContainer } = created.data;
    const checkoutsBefore = [worktreePaths(projectPath), worktreePaths(otherProjectPath)];

    await expectFailsWithSaveError(() => service.rename(id, "multi-after"));
    expect([worktreePaths(projectPath), worktreePaths(otherProjectPath)]).toEqual(checkoutsBefore);
    expect(git(projectPath, "branch", "--list", "multi-after")).toBe("");
    expect(await exists(path.join(oldContainer, "project", "README.md"))).toBe(true);
    expect(await exists(path.join(path.dirname(oldContainer), "multi-after"))).toBe(false);

    expect((await service.rename(id, "multi-after")).success).toBe(true);
  });

  test("local multi-project rename moves the container back though its path is unchanged", async () => {
    // A multi-project task/fork on the local runtime lives under a real project at the project
    // path; LocalRuntime reports that path as both old and new, so only the name shows the move.
    const containers = path.join(harness.config.srcDir, "_workspaces");
    await fs.mkdir(path.join(containers, "local-before"), { recursive: true });
    await harness.config.editConfig((cfg) => {
      cfg.projects.get(projectPath)!.workspaces.push({
        id: "ddddddddd1",
        name: "local-before",
        path: projectPath,
        runtimeConfig: { type: "local" },
        projects: projects(),
      });
      return cfg;
    });

    await expectFailsWithSaveError(() => service.rename("ddddddddd1", "local-after"));
    expect(await exists(path.join(containers, "local-before"))).toBe(true);
    expect(await exists(path.join(containers, "local-after"))).toBe(false);
  });

  test("rename leaves the moved checkout when the config cannot be read back", async () => {
    const created = await createWorktree("keep-before");
    if (!created.success) throw new Error(created.error);
    const publish = failConfigPublish({ corruptConfig: true });
    const result = await service
      .rename(created.data.metadata.id, "keep-after")
      .finally(() => publish.mockRestore());

    expect(result.success ? "" : result.error).toContain("EACCES");
    // Unreadable config is not proof the rename did not land, so the move stays.
    expect(worktreePaths(projectPath).map((p) => path.basename(p))).toContain("keep-after");
  });

  test("fork with a name matching an existing branch keeps that branch", async () => {
    const source = await createWorktree("source");
    if (!source.success) throw new Error(source.error);
    git(projectPath, "branch", "fork-b");
    const tip = git(projectPath, "rev-parse", "fork-b");

    await expectFailsWithSaveError(() => service.fork(source.data.metadata.id, "fork-b"));
    expect(git(projectPath, "rev-parse", "fork-b")).toBe(tip);
    expect(worktreePaths(projectPath).map((p) => path.basename(p))).not.toContain("fork-b");
  });

  test("create keeps its checkout when the config cannot be read back", async () => {
    const publish = failConfigPublish({ corruptConfig: true });
    const result = await createWorktree("feature-c").finally(() => publish.mockRestore());

    expect(result.success ? "" : result.error).toContain("EACCES");
    // Unreadable is not proof the entry is gone, so nothing is deleted.
    expect(worktreePaths(projectPath).map((p) => path.basename(p))).toContain("feature-c");
  });

  // #4818: an Err after the registration write must not leave a workspace the caller was told
  // does not exist (it would be listed, and after the consent grant, messageable).
  test.each([
    { label: "a branch it made", existingBranch: false },
    { label: "an existing branch", existingBranch: true },
  ])(
    "create failing after registration on $label rolls it back and keeps the error",
    async ({ existingBranch }) => {
      const tip = existingBranch ? branchWithOwnCommit(projectPath, "after-reg") : undefined;
      const workspaceId = "ddddddddd1";
      spyOn(harness.config, "generateStableId").mockReturnValueOnce(workspaceId);
      spyOn(harness.config, "getAllWorkspaceMetadata").mockResolvedValueOnce([]);

      const result = await createWorktree("after-reg");
      expect(result.success ? "" : result.error).toContain("Failed to retrieve workspace metadata");
      await expectNoCreationLeftovers(workspaceId, "after-reg", [projectPath]);
      if (tip === undefined) {
        expect(git(projectPath, "branch", "--list", "after-reg")).toBe("");
      } else {
        expect(git(projectPath, "rev-parse", "after-reg")).toBe(tip);
      }
      expect((await createWorktree("after-reg")).success).toBe(true);
    }
  );

  // #4842: a sanitize failure aborts the creation like a failed registration does, so it must
  // keep a branch the creation reused; a plain delete's `git branch -d` removes a merged one.
  test.each([
    { label: "materialized, a branch it made", awaitMaterialization: true, existingBranch: false },
    { label: "materialized, an existing branch", awaitMaterialization: true, existingBranch: true },
    { label: "deferred, a branch it made", awaitMaterialization: false, existingBranch: false },
    { label: "deferred, an existing branch", awaitMaterialization: false, existingBranch: true },
  ])(
    "create ($label) aborted by a failed sanitization keeps only the branch it did not make",
    async ({ awaitMaterialization, existingBranch }) => {
      // Merged into main, so `git branch -d` would delete it.
      if (existingBranch) git(projectPath, "branch", "sanitize-fail");
      const tip = existingBranch ? git(projectPath, "rev-parse", "sanitize-fail") : undefined;
      const workspaceId = "ddddddddd4";
      spyOn(harness.config, "generateStableId").mockReturnValueOnce(workspaceId);
      spyOn(
        service as unknown as {
          sanitizeStalePluginOverridesForNewWorkspace: () => Promise<string | undefined>;
        },
        "sanitizeStalePluginOverridesForNewWorkspace"
      ).mockResolvedValue("override file unreadable");

      const result = await createWorktree("sanitize-fail", awaitMaterialization);
      if (awaitMaterialization) {
        expect(result.success ? "" : result.error).toBe("override file unreadable");
      } else {
        // The deferred checkout is sanitized after creation returns; wait for its abort.
        expect(result.success).toBe(true);
        await (
          service as unknown as { initSettlementPromises: Map<string, Promise<void>> }
        ).initSettlementPromises.get(workspaceId);
      }
      await expectNoCreationLeftovers(workspaceId, "sanitize-fail", [projectPath]);
      if (tip === undefined) {
        expect(git(projectPath, "branch", "--list", "sanitize-fail")).toBe("");
      } else {
        expect(git(projectPath, "rev-parse", "sanitize-fail")).toBe(tip);
      }
    }
  );

  test("create whose cleanup throws after the deregistration still reports it rolled back", async () => {
    const workspaceId = "ddddddddd2";
    spyOn(harness.config, "generateStableId").mockReturnValueOnce(workspaceId);
    spyOn(harness.config, "getAllWorkspaceMetadata").mockResolvedValueOnce([]);
    spyOn(initStateManager, "deleteInitStatus").mockRejectedValueOnce(new Error("EBUSY"));

    const result = await createWorktree("cleanup-throws");
    expect(result.success ? "" : result.error).toContain("Failed to retrieve workspace metadata");
    expect(result.success ? "" : result.error).not.toContain("could not be rolled back");
    expect(persistedWorkspaceIds()).not.toContain(workspaceId);
  });

  test("fork failing after registration rolls it back, leaving the source intact", async () => {
    const source = await createWorktree("source");
    if (!source.success) throw new Error(source.error);
    const sourceId = source.data.metadata.id;
    const goals = new WorkspaceGoalService(
      harness.config,
      harness.historyService,
      harness.extensionMetadata
    );
    service.setWorkspaceGoalService(goals);
    spyOn(goals, "inheritFromFork").mockRejectedValueOnce(new Error("goal store unavailable"));
    const forkId = "ddddddddd3";
    spyOn(harness.config, "generateStableId").mockReturnValueOnce(forkId);

    const result = await service.fork(sourceId, "fork-after-reg");
    expect(result.success ? "" : result.error).toContain("goal store unavailable");
    await expectNoCreationLeftovers(forkId, "fork-after-reg", [projectPath]);
    expect(git(projectPath, "branch", "--list", "fork-after-reg")).toBe("");
    expect(persistedWorkspaceIds()).toEqual([sourceId]);
    expect((await service.fork(sourceId, "fork-after-reg")).success).toBe(true);
  });

  // #4842: the #4818 rule for createMultiProject; its row even carries consent from the start.
  test("createMultiProject failing after registration rolls it back and keeps the error", async () => {
    git(projectPath, "branch", "multi-after");
    const tip = git(projectPath, "rev-parse", "multi-after");
    const workspaceId = "ddddddddd5";
    spyOn(harness.config, "generateStableId").mockReturnValueOnce(workspaceId);
    spyOn(harness.config, "getAllWorkspaceMetadata").mockResolvedValueOnce([]);

    const create = () =>
      service.createMultiProject(projects(), "multi-after", "main", undefined, {
        type: "worktree",
        srcBaseDir,
      });
    const result = await create();
    expect(result.success ? "" : result.error).toContain("Failed to retrieve workspace metadata");
    await expectNoCreationLeftovers(workspaceId, "multi-after", [projectPath, otherProjectPath]);
    expect(await exists(path.join(srcBaseDir, "_workspaces", "multi-after"))).toBe(false);
    expect(git(projectPath, "rev-parse", "multi-after")).toBe(tip);
    expect(git(otherProjectPath, "branch", "--list", "multi-after")).toBe("");
    expect((await create()).success).toBe(true);
  });

  test("createMultiProject keeps a failed registration another backend already uses", async () => {
    const workspaceId = "ddddddddd6";
    spyOn(harness.config, "generateStableId").mockReturnValueOnce(workspaceId);
    // Another backend starts a turn in the persisted row before the metadata read fails.
    const foreignLeases = new WorkspaceUseLeases(harness.config.rootDir);
    let foreignTurn: WorkspaceUseLease | undefined;
    spyOn(harness.config, "getAllWorkspaceMetadata").mockImplementationOnce(async () => {
      foreignTurn = await foreignLeases.hold(workspaceId, "turn");
      return [];
    });

    try {
      const result = await service.createMultiProject(
        projects(),
        "multi-busy-reg",
        "main",
        undefined,
        {
          type: "worktree",
          srcBaseDir,
        }
      );
      expect(result.success ? "" : result.error).toContain("could not be rolled back");
      expect(persistedWorkspaceIds()).toContain(workspaceId);
      for (const repo of [projectPath, otherProjectPath]) {
        expect(worktreePaths(repo).map((p) => path.basename(p))).toContain("multi-busy-reg");
      }
      expect(await exists(path.join(srcBaseDir, "_workspaces", "multi-busy-reg"))).toBe(true);
    } finally {
      await foreignTurn?.release();
    }
  });

  // #4883: the create()/fork() rollbacks after the registration write follow the same rule.
  /** Another backend's lease on `workspaceId`, taken the first time `hold` runs. */
  function foreignTurn(workspaceId: string) {
    const leases = new WorkspaceUseLeases(harness.config.rootDir);
    let lease: WorkspaceUseLease | undefined;
    return {
      hold: async () => {
        lease ??= await leases.hold(workspaceId, "turn");
      },
      release: () => lease?.release(),
    };
  }

  test("create keeps a failed registration another backend already uses", async () => {
    const workspaceId = "ddddddddd7";
    spyOn(harness.config, "generateStableId").mockReturnValueOnce(workspaceId);
    const foreign = foreignTurn(workspaceId);
    spyOn(harness.config, "getAllWorkspaceMetadata").mockImplementationOnce(async () => {
      await foreign.hold();
      return [];
    });
    try {
      const result = await createWorktree("busy-after-reg");
      expect(result.success ? "" : result.error).toContain("could not be rolled back");
      expect(persistedWorkspaceIds()).toContain(workspaceId);
      expect(worktreePaths(projectPath).map((p) => path.basename(p))).toContain("busy-after-reg");
    } finally {
      await foreign.release();
    }
  });

  test.each([
    { label: "materialized", awaitMaterialization: true },
    { label: "deferred", awaitMaterialization: false },
  ])(
    "create ($label) aborted by a failed sanitization keeps a row another backend already uses",
    async ({ awaitMaterialization }) => {
      const workspaceId = "ddddddddd8";
      spyOn(harness.config, "generateStableId").mockReturnValueOnce(workspaceId);
      const foreign = foreignTurn(workspaceId);
      spyOn(
        service as unknown as {
          sanitizeStalePluginOverridesForNewWorkspace: () => Promise<string | undefined>;
        },
        "sanitizeStalePluginOverridesForNewWorkspace"
      ).mockImplementation(async () => {
        await foreign.hold();
        return "override file unreadable";
      });
      const metadataEvents: unknown[] = [];
      service.on("metadata", (event: { metadata: unknown }) => metadataEvents.push(event.metadata));
      try {
        const result = await createWorktree("busy-sanitize", awaitMaterialization);
        if (awaitMaterialization) {
          expect(result.success ? "" : result.error).toContain("could not be rolled back");
        } else {
          expect(result.success).toBe(true);
          await (
            service as unknown as { initSettlementPromises: Map<string, Promise<void>> }
          ).initSettlementPromises.get(workspaceId);
          // Kept, so it stays listed.
          expect(metadataEvents).not.toContain(null);
        }
        expect(persistedWorkspaceIds()).toContain(workspaceId);
        expect(worktreePaths(projectPath).map((p) => path.basename(p))).toContain("busy-sanitize");
      } finally {
        await foreign.release();
      }
    }
  );

  test("fork keeps a failed registration another backend already uses", async () => {
    const source = await createWorktree("busy-source");
    if (!source.success) throw new Error(source.error);
    const goals = new WorkspaceGoalService(
      harness.config,
      harness.historyService,
      harness.extensionMetadata
    );
    service.setWorkspaceGoalService(goals);
    const forkId = "ddddddddd9";
    spyOn(harness.config, "generateStableId").mockReturnValueOnce(forkId);
    const foreign = foreignTurn(forkId);
    spyOn(goals, "inheritFromFork").mockImplementationOnce(async () => {
      await foreign.hold();
      throw new Error("goal store unavailable");
    });
    try {
      const result = await service.fork(source.data.metadata.id, "busy-fork");
      expect(result.success ? "" : result.error).toContain("could not be rolled back");
      expect(persistedWorkspaceIds()).toContain(forkId);
      expect(worktreePaths(projectPath).map((p) => path.basename(p))).toContain("busy-fork");
    } finally {
      await foreign.release();
    }
  });

  // #4775 item 7: MultiProjectRuntime.deleteWorkspace must forward keepBranch to every project.
  const createMultiSource = async () => {
    const source = await service.createMultiProject(projects(), "multi-src", "main", undefined, {
      type: "worktree",
      srcBaseDir,
    });
    if (!source.success) throw new Error(source.error);
    return source.data.id;
  };

  test("multi-project fork keeps an existing branch and removes the ones it made", async () => {
    const sourceId = await createMultiSource();
    const tip = branchWithOwnCommit(projectPath, "multi-fork");

    await expectFailsWithSaveError(() => service.fork(sourceId, "multi-fork"));
    expect(git(projectPath, "rev-parse", "multi-fork")).toBe(tip);
    // A branch left behind would make a retry reuse its stale tip.
    expect(git(otherProjectPath, "branch", "--list", "multi-fork")).toBe("");
    for (const repo of [projectPath, otherProjectPath]) {
      expect(worktreePaths(repo).map((p) => path.basename(p))).not.toContain("multi-fork");
    }
  });

  test("multi-project fork that fails in a later project keeps the earlier existing branch", async () => {
    const sourceId = await createMultiSource();
    // Merged into main, so even the non-forced `git branch -d` of the orchestrator rollback deletes it.
    git(projectPath, "branch", "multi-busy");
    const tip = git(projectPath, "rev-parse", "multi-busy");
    // Checked out elsewhere in the second project, so that project's fork fails after the first's.
    git(
      otherProjectPath,
      "worktree",
      "add",
      path.join(harness.rootDir, "busy"),
      "-b",
      "multi-busy"
    );

    const result = await service.fork(sourceId, "multi-busy");
    expect(result.success ? "" : result.error).toContain("Failed to fork project other");
    expect(git(projectPath, "rev-parse", "multi-busy")).toBe(tip);
    expect(worktreePaths(projectPath).map((p) => path.basename(p))).not.toContain("multi-busy");
  });
});
