import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { execFileSync } from "child_process";
import cjsFs from "fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { Result } from "@/common/types/result";
import type { ExperimentsService } from "./experimentsService";
import { CoderService } from "./coderService";
import * as disposableExec from "@/node/utils/disposableExec";
import { WorkspaceGoalService } from "./workspaceGoalService";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import { RuntimeError } from "@/node/runtime/Runtime";
import { WorktreeRuntime } from "@/node/runtime/WorktreeRuntime";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { SSHRuntime } from "@/node/runtime/SSHRuntime";
import { DockerRuntime, getContainerName } from "@/node/runtime/DockerRuntime";
import * as devcontainerCli from "@/node/runtime/devcontainerCli";
import { getPlanFilePath } from "@/common/utils/planStorage";
import { ContainerManager } from "@/node/multiProject/containerManager";
import * as runtimeHelpers from "@/node/utils/runtime/helpers";
import type { InitStateManager } from "./initStateManager";
import { WorkspaceUseLeases, type WorkspaceUseLease } from "./workspaceUseLeases";
import type { WorkspaceService } from "./workspaceService";
import {
  createWorkspaceServiceHarness,
  withTempMuxRoot,
  writePlanFile,
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
      callback(Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" }));
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
  expect(result.success ? "" : result.error).toContain("EROFS");
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
    // Two real repos are created with git subprocesses; on a CPU-saturated host this took up to
    // about 2.6 s, so the 5 s hook default leaves too little margin (#5401).
  }, 30_000);

  /**
   * The retained settlements of this service's background inits. Each settles after its init use
   * lease is released (withInitUseLease), unlike init-end, which fires inside the lease.
   */
  const initSettlements = () =>
    (service as unknown as { initSettlementPromises: Map<string, Promise<void>> })
      .initSettlementPromises;

  afterEach(async () => {
    // Let deferred checkouts of successful retries finish before the temp root goes away.
    await Promise.all(initSettlements().values());
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

  // A legacy `{ type: "local", srcBaseDir }` config is a worktree runtime, not a project-dir one.
  // The timeout is raised, not replaced by a signal: there is no wait or poll here, only real git
  // subprocesses (create, fork, rollback and the checks). Alone they take well under 1 s; on a
  // CPU-saturated host they took up to about 3.7 s against the 5 s default (#5401).
  test("fork of a legacy local-with-srcBaseDir workspace removes its worktree", async () => {
    const source = await service.create(
      projectPath,
      "legacy-src",
      "main",
      undefined,
      { type: "local", srcBaseDir },
      undefined,
      undefined,
      undefined,
      { awaitMaterialization: true }
    );
    if (!source.success) throw new Error(source.error);

    await expectFailsWithSaveError(() => service.fork(source.data.metadata.id, "legacy-fork"));
    expect(worktreePaths(projectPath).map((p) => path.basename(p))).not.toContain("legacy-fork");
    expect(git(projectPath, "branch", "--list", "legacy-fork")).toBe("");
  }, 30_000);

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
    // createMultiProject runs its per-project init for real (the runBackgroundInit mock does not
    // cover it) under an "init" use lease taken after it returns. A rename refuses while that
    // lease is held (#4857), so without this wait it got the init refusal instead of the save
    // error whenever the init took its lease first (#4938).
    await initSettlements().get(id);
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

    expect(result.success ? "" : result.error).toContain("EROFS");
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

    expect(result.success ? "" : result.error).toContain("EROFS");
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

  // #4842: the #4818 rule for createMultiProject.
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

  // #4899: a rollback that could not delete what it made says so, so a retry under the same name
  // does not collide with a leftover the caller was never told about.
  describe("reports what a rollback could not clean up", () => {
    const leftoverCheckout = (name: string) =>
      worktreePaths(projectPath).find((p) => path.basename(p) === name);

    test("create failing after registration names the checkout it could not delete", async () => {
      spyOn(harness.config, "getAllWorkspaceMetadata").mockResolvedValueOnce([]);
      spyOn(WorktreeRuntime.prototype, "deleteWorkspace").mockResolvedValueOnce({
        success: false,
        error: "EBUSY",
      });

      const result = await createWorktree("leftover-a");
      const error = result.success ? "" : result.error;
      expect(error).toContain("Failed to retrieve workspace metadata");
      const checkout = leftoverCheckout("leftover-a");
      expect(checkout).toBeDefined();
      expect(error).toContain(`could not be fully cleaned up: ${checkout!}; delete it`);
    });

    test("create keeps naming the leftover checkout when a later cleanup step throws", async () => {
      spyOn(harness.config, "getAllWorkspaceMetadata").mockResolvedValueOnce([]);
      spyOn(WorktreeRuntime.prototype, "deleteWorkspace").mockResolvedValueOnce({
        success: false,
        error: "EBUSY",
      });
      spyOn(initStateManager, "deleteInitStatus").mockRejectedValueOnce(new Error("EBUSY"));

      const result = await createWorktree("leftover-c");
      const error = result.success ? "" : result.error;
      expect(error).not.toContain("could not be rolled back");
      expect(error).toContain(`could not be fully cleaned up: ${leftoverCheckout("leftover-c")!}`);
    });

    test("create whose registration write rejects names the checkout it could not delete", async () => {
      spyOn(WorktreeRuntime.prototype, "deleteWorkspace").mockRejectedValueOnce(new Error("EIO"));

      const publish = failConfigPublish();
      const result = await createWorktree("leftover-b").finally(() => publish.mockRestore());
      const error = result.success ? "" : result.error;
      expect(error).toContain("EROFS");
      expect(error).toContain(`could not be fully cleaned up: ${leftoverCheckout("leftover-b")!}`);
    });

    test("fork failing after registration names the checkout it could not delete", async () => {
      const source = await createWorktree("leftover-src");
      if (!source.success) throw new Error(source.error);
      const goals = new WorkspaceGoalService(
        harness.config,
        harness.historyService,
        harness.extensionMetadata
      );
      service.setWorkspaceGoalService(goals);
      spyOn(goals, "inheritFromFork").mockRejectedValueOnce(new Error("goal store unavailable"));
      spyOn(WorktreeRuntime.prototype, "deleteWorkspace").mockRejectedValueOnce(new Error("EIO"));

      const result = await service.fork(source.data.metadata.id, "leftover-fork");
      const error = result.success ? "" : result.error;
      expect(error).toContain("goal store unavailable");
      expect(error).toContain(
        `could not be fully cleaned up: ${leftoverCheckout("leftover-fork")!}`
      );
    });

    test("createMultiProject failing after registration names the container it could not delete", async () => {
      spyOn(harness.config, "getAllWorkspaceMetadata").mockResolvedValueOnce([]);
      spyOn(ContainerManager.prototype, "removeContainer").mockRejectedValueOnce(
        new Error("EBUSY")
      );

      const result = await service.createMultiProject(
        projects(),
        "leftover-multi",
        "main",
        undefined,
        {
          type: "worktree",
          srcBaseDir,
        }
      );
      const error = result.success ? "" : result.error;
      expect(error).toContain("Failed to retrieve workspace metadata");
      const container = path.join(srcBaseDir, "_workspaces", "leftover-multi");
      expect(await exists(container)).toBe(true);
      expect(error).toContain(`could not be fully cleaned up: ${container}; delete it`);
    });
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

  test("create whose mutation gate cannot be taken keeps the row and discards its creation state", async () => {
    const workspaceId = "ddddddddda";
    spyOn(harness.config, "generateStableId").mockReturnValueOnce(workspaceId);
    spyOn(harness.config, "getAllWorkspaceMetadata").mockResolvedValueOnce([]);
    spyOn(WorkspaceUseLeases.prototype, "acquireMutationGate").mockRejectedValueOnce(
      Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
    );

    const result = await createWorktree("gate-io-error");
    expect(result.success ? "" : result.error).toContain("could not be rolled back");
    expect(persistedWorkspaceIds()).toContain(workspaceId);
    expect(initStateManager.getInitState(workspaceId)).toBeUndefined();
    const sessions = (service as unknown as { sessions: Map<string, unknown> }).sessions;
    expect(sessions.has(workspaceId)).toBe(false);
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

  // #4775 items 2 and 3, #4936: leftovers the creation and fork rollbacks used to miss.
  describe("rollback gaps (#4775, #4936)", () => {
    const leftoverSentence = (paths: string[]) =>
      `The workspace could not be fully cleaned up: ${paths.join(", ")}; delete ${paths.length === 1 ? "it" : "them"} before retrying.`;

    test("fork copy failure keeps naming the leftover checkout when a later cleanup step throws", async () => {
      const source = await createWorktree("copy-src");
      if (!source.success) throw new Error(source.error);
      spyOn(runtimeHelpers, "copyPlanFileAcrossRuntimes").mockRejectedValueOnce(
        new Error("plan unreadable")
      );
      spyOn(WorktreeRuntime.prototype, "deleteWorkspace").mockResolvedValueOnce({
        success: false,
        error: "EBUSY",
      });
      spyOn(initStateManager, "deleteInitStatus").mockRejectedValueOnce(new Error("EBUSY"));

      const result = await service.fork(source.data.metadata.id, "copy-fork");
      const error = result.success ? "" : result.error;
      const checkout = worktreePaths(projectPath).find((p) => path.basename(p) === "copy-fork");
      expect(checkout).toBeDefined();
      expect(error).toBe(
        `Failed to copy fork state: plan unreadable ${leftoverSentence([checkout!])}`
      );
    });

    // A later workspace with the fork's name would inherit a plan copy left behind.
    test.each([
      { label: "registration write rejects", sanitizeFails: false },
      { label: "sanitization fails", sanitizeFails: true },
    ])("fork whose $label deletes the plan it copied", async ({ sanitizeFails }) => {
      await withTempMuxRoot(async (root) => {
        const source = await createWorktree("plan-src");
        if (!source.success) throw new Error(source.error);
        const sourcePlan = await writePlanFile(root, "project", "plan-src");
        if (sanitizeFails) {
          spyOn(
            service as unknown as {
              sanitizeStalePluginOverridesForNewWorkspace: () => Promise<string | undefined>;
            },
            "sanitizeStalePluginOverridesForNewWorkspace"
          ).mockResolvedValue("override file unreadable");
          const result = await service.fork(source.data.metadata.id, "plan-fork");
          expect(result.success ? "" : result.error).toBe("override file unreadable");
        } else {
          await expectFailsWithSaveError(() => service.fork(source.data.metadata.id, "plan-fork"));
        }
        expect(await exists(getPlanFilePath("plan-fork", "project", root))).toBe(false);
        expect(await exists(sourcePlan)).toBe(true);
      });
    });

    test("fork names the plan copy it could not delete", async () => {
      await withTempMuxRoot(async (root) => {
        const source = await createWorktree("plan-src2");
        if (!source.success) throw new Error(source.error);
        await writePlanFile(root, "project", "plan-src2");
        const forkPlan = getPlanFilePath("plan-fork2", "project", root);
        // A directory where the copy's file goes: `rm -f` cannot remove it.
        spyOn(runtimeHelpers, "copyPlanFileAcrossRuntimes").mockImplementationOnce(async () => {
          await fs.mkdir(path.join(forkPlan, "blocker"), { recursive: true });
          return "~/.xum/plans/project/plan-fork2.md";
        });

        const publish = failConfigPublish();
        const result = await service
          .fork(source.data.metadata.id, "plan-fork2")
          .finally(() => publish.mockRestore());
        expect(result.success ? "" : result.error).toEndWith(
          leftoverSentence(["~/.xum/plans/project/plan-fork2.md"])
        );
      });
    });

    // #5009: plan paths depend only on project and workspace name, so a fork that takes an existing
    // workspace's name would overwrite that workspace's plan. Project-dir forks never fail on the
    // name by themselves, so fork() must refuse it before copying anything.
    describe("fork name collisions (#5009)", () => {
      const addLocalWorkspace = (id: string, name: string) =>
        harness.config.editConfig((cfg) => {
          cfg.projects.get(projectPath)!.workspaces.push({
            id,
            name,
            path: projectPath,
            runtimeConfig: { type: "local" },
          });
          return cfg;
        });
      const writeDistinctPlan = async (root: string, name: string) => {
        const planPath = await writePlanFile(root, "project", name);
        await fs.writeFile(planPath, `# ${name}'s own plan\n`);
        return planPath;
      };

      test.each([
        { label: "its source", target: "local-one" },
        { label: "another workspace", target: "local-two" },
      ])("local fork named like $label is refused and no plan changes", async (c) => {
        await withTempMuxRoot(async (root) => {
          await addLocalWorkspace("eeeeeeeee2", "local-one");
          await addLocalWorkspace("eeeeeeeee3", "local-two");
          const plans = [
            await writeDistinctPlan(root, "local-one"),
            await writeDistinctPlan(root, "local-two"),
          ];
          const before = await Promise.all(plans.map((p) => fs.readFile(p)));
          const copy = spyOn(runtimeHelpers, "copyPlanFileAcrossRuntimes");
          const workspacesBefore = persistedWorkspaceIds();

          const result = await service.fork("eeeeeeeee2", c.target);

          expect(result.success ? "" : result.error).toBe(
            `Workspace with name "${c.target}" already exists in this project`
          );
          expect(copy).not.toHaveBeenCalled();
          expect(await Promise.all(plans.map((p) => fs.readFile(p)))).toEqual(before);
          expect(persistedWorkspaceIds()).toEqual(workspacesBefore);
        });
      });

      // Worktree runtimes would fail later on the existing checkout; the refusal is uniform and early.
      test("worktree fork named like another workspace is refused before orchestration", async () => {
        const source = await createWorktree("wt-src");
        if (!source.success) throw new Error(source.error);
        await addLocalWorkspace("eeeeeeeee4", "wt-taken");
        const worktreesBefore = worktreePaths(projectPath);

        const result = await service.fork(source.data.metadata.id, "wt-taken");

        expect(result.success ? "" : result.error).toBe(
          'Workspace with name "wt-taken" already exists in this project'
        );
        expect(worktreePaths(projectPath)).toEqual(worktreesBefore);
      });

      // Orphaned plans remain (older builds, failed deletions after removal, #5019); a fork may
      // reuse that name, and its rollback must not delete
      // a file its copy did not create (#5003).
      test("failed local fork over an orphaned plan leaves that file in place", async () => {
        await withTempMuxRoot(async (root) => {
          await addLocalWorkspace("eeeeeeeee7", "local-src2");
          await writeDistinctPlan(root, "local-src2");
          const orphanPlan = await writeDistinctPlan(root, "removed-ws");

          await expectFailsWithSaveError(() => service.fork("eeeeeeeee7", "removed-ws"));
          expect(await exists(orphanPlan)).toBe(true);
        });
      });

      // #5026: both forks pass the early check before either registers; the registration write
      // re-checks the name, and the loser must not delete the plan both copies wrote to.
      test("concurrent local forks with one name: exactly one registers, the other leaves nothing", async () => {
        await withTempMuxRoot(async (root) => {
          await addLocalWorkspace("eeeeeeeee8", "race-a");
          await addLocalWorkspace("eeeeeeeee9", "race-b");
          await writeDistinctPlan(root, "race-a");
          await writeDistinctPlan(root, "race-b");
          // Hold both forks at the plan copy (after the early name check) until both arrive.
          const realCopy = runtimeHelpers.copyPlanFileAcrossRuntimes;
          let arrived = 0;
          let releaseCopies!: () => void;
          const bothArrived = new Promise<void>((resolve) => (releaseCopies = resolve));
          spyOn(runtimeHelpers, "copyPlanFileAcrossRuntimes").mockImplementation(
            async (...args) => {
              arrived += 1;
              if (arrived === 2) releaseCopies();
              await bothArrived;
              return realCopy(...args);
            }
          );
          const newIds = spyOn(harness.config, "generateStableId");

          const results = await Promise.all([
            service.fork("eeeeeeeee8", "race-fork"),
            service.fork("eeeeeeeee9", "race-fork"),
          ]);

          expect(arrived).toBe(2);
          const winners = results.filter((r) => r.success);
          const errors = results.flatMap((r) => (r.success ? [] : [r.error]));
          expect(winners).toHaveLength(1);
          expect(errors).toEqual([
            'Failed to fork workspace: Workspace with name "race-fork" already exists in this project',
          ]);
          const winnerId = winners[0].success ? winners[0].data.metadata.id : "";
          const loserIds = newIds.mock.results
            .map((r) => r.value as string)
            .filter((id) => id !== winnerId);
          expect(loserIds).toHaveLength(1);
          await expectNoCreationLeftovers(loserIds[0], "race-fork", []);
          const names = [...harness.config.loadConfigOrDefault().projects.values()].flatMap((p) =>
            p.workspaces.map((w) => w.name)
          );
          expect(names.filter((n) => n === "race-fork")).toHaveLength(1);
          // The winner's plan path is shared with the loser's copy; the loser's rollback keeps it.
          expect(await exists(getPlanFilePath("race-fork", "project", root))).toBe(true);
        });
      });

      test("local fork with a new name still copies the source plan", async () => {
        await withTempMuxRoot(async (root) => {
          await addLocalWorkspace("eeeeeeeee5", "local-src");
          const sourcePlan = await writeDistinctPlan(root, "local-src");

          const result = await service.fork("eeeeeeeee5", "local-new");

          expect(result.success ? "" : result.error).toBe("");
          expect(await fs.readFile(getPlanFilePath("local-new", "project", root), "utf8")).toBe(
            await fs.readFile(sourcePlan, "utf8")
          );
        });
      });
    });

    // A devcontainer stores the fork's plan inside its container; the host file at the same path is
    // someone else's.
    test("devcontainer fork rollback leaves the host plan path alone", async () => {
      await withTempMuxRoot(async (root) => {
        spyOn(devcontainerCli, "devcontainerDown").mockResolvedValue({ kind: "absent" });
        const source = await service.create(projectPath, "dc-src", "main", undefined, {
          type: "devcontainer",
          configPath: ".devcontainer/devcontainer.json",
        });
        if (!source.success) throw new Error(source.error);
        const hostPlan = await writePlanFile(root, "project", "dc-fork");
        spyOn(runtimeHelpers, "copyPlanFileAcrossRuntimes").mockResolvedValueOnce(
          "~/.xum/plans/project/dc-fork.md"
        );

        await expectFailsWithSaveError(() => service.fork(source.data.metadata.id, "dc-fork"));
        expect(await exists(hostPlan)).toBe(true);
      });
    });

    // Item 2: a devcontainer creation owns only its host worktree before init runs; no container
    // exists yet, and `devcontainer down` matches containers by path, so it must not run.
    test.each([
      { label: "a branch it made", existingBranch: false },
      { label: "an existing branch", existingBranch: true },
    ])(
      "devcontainer create rollback on $label removes only the host worktree",
      async ({ existingBranch }) => {
        await withTempMuxRoot(async () => {
          const tip = existingBranch ? branchWithOwnCommit(projectPath, "dc-a") : undefined;
          const down = spyOn(devcontainerCli, "devcontainerDown").mockResolvedValue({
            kind: "absent",
          });
          const createDevcontainer = () =>
            service.create(projectPath, "dc-a", "main", undefined, {
              type: "devcontainer",
              configPath: ".devcontainer/devcontainer.json",
            });

          await expectFailsWithSaveError(createDevcontainer);
          expect(worktreePaths(projectPath)).toHaveLength(1);
          if (tip === undefined) {
            expect(git(projectPath, "branch", "--list", "dc-a")).toBe("");
          } else {
            expect(git(projectPath, "rev-parse", "dc-a")).toBe(tip);
          }
          expect(down).not.toHaveBeenCalled();
          expect((await createDevcontainer()).success).toBe(true);
        });
      }
    );

    // Item 2, devcontainer forks: the fork started its init, and so possibly its container, before
    // it registered. Its rollback removes that container (which holds the fork's plan copy) with
    // the checkout, and keeps a branch the fork reused.
    test.each([
      { label: "a branch it made", existingBranch: false },
      { label: "an existing branch", existingBranch: true },
    ])(
      "devcontainer fork rollback on $label removes its checkout and container",
      async ({ existingBranch }) => {
        await withTempMuxRoot(async () => {
          const down = spyOn(devcontainerCli, "devcontainerDown").mockResolvedValue({
            kind: "absent",
          });
          spyOn(runtimeHelpers, "copyPlanFileAcrossRuntimes").mockResolvedValue(undefined);
          const source = await service.create(projectPath, "dcf-src", "main", undefined, {
            type: "devcontainer",
            configPath: ".devcontainer/devcontainer.json",
          });
          if (!source.success) throw new Error(source.error);
          const tip = existingBranch ? branchWithOwnCommit(projectPath, "dcf") : undefined;

          await expectFailsWithSaveError(() => service.fork(source.data.metadata.id, "dcf"));
          expect(worktreePaths(projectPath).map((p) => path.basename(p))).not.toContain("dcf");
          if (tip === undefined) {
            expect(git(projectPath, "branch", "--list", "dcf")).toBe("");
          } else {
            expect(git(projectPath, "rev-parse", "dcf")).toBe(tip);
          }
          expect(down.mock.calls.map(([folder]) => path.basename(folder))).toEqual(["dcf"]);
          expect((await service.fork(source.data.metadata.id, "dcf")).success).toBe(true);
        });
      }
    );

    // #5120: a container the rollback could not remove still holds the fork's plan copy, and a
    // retry at the same path would reuse it, so the rollback names it.
    test("devcontainer fork rollback names the container it could not remove", async () => {
      await withTempMuxRoot(async () => {
        spyOn(runtimeHelpers, "copyPlanFileAcrossRuntimes").mockResolvedValue(undefined);
        const source = await service.create(projectPath, "dce-src", "main", undefined, {
          type: "devcontainer",
          configPath: ".devcontainer/devcontainer.json",
        });
        if (!source.success) throw new Error(source.error);
        spyOn(devcontainerCli, "devcontainerDown").mockResolvedValue({
          kind: "error",
          message: "Failed to remove container: daemon down",
        });

        const publish = failConfigPublish();
        const result = await service
          .fork(source.data.metadata.id, "dce")
          .finally(() => publish.mockRestore());
        const error = result.success ? "" : result.error;
        expect(error).toContain("EROFS");
        // The label names the fork's host checkout, which the rollback removed.
        expect(error).toMatch(
          /could not be fully cleaned up: devcontainer container labeled devcontainer\.local_folder=\S+\/dce; delete it before retrying\.$/
        );
      });
    });

    // Item 2, SSH forks (Coder forks too, in existing mode): the fork made its remote worktree at a
    // path it checked was free, before registering. It is removed; the branch is kept unless the
    // fork reports it made it (#5119), which this mock does not.
    test("SSH fork rollback removes the fork's checkout", async () => {
      const runtimeConfig = {
        type: "ssh" as const,
        host: "example.invalid",
        srcBaseDir: "/remote/src",
      };
      const prototype = SSHRuntime.prototype;
      await harness.config.editConfig((cfg) => {
        cfg.projects.get(projectPath)!.workspaces.push({
          id: "fffffffff1",
          name: "remote-src",
          path: "/remote/src/project/remote-src",
          runtimeConfig,
        });
        return cfg;
      });
      spyOn(prototype, "forkWorkspace").mockResolvedValue({
        success: true,
        workspacePath: "/remote/src/project/remote-fork",
        sourceBranch: "remote-src",
      });
      const deleteWorkspace = spyOn(prototype, "deleteWorkspace").mockResolvedValue({
        success: true,
        deletedPath: "/remote/src/project/remote-fork",
      });
      spyOn(runtimeHelpers, "copyPlanFileAcrossRuntimes").mockResolvedValue(undefined);

      await expectFailsWithSaveError(() => service.fork("fffffffff1", "remote-fork"));
      expect(deleteWorkspace).toHaveBeenCalledTimes(1);
      expect(deleteWorkspace.mock.calls[0].slice(0, 3)).toEqual([projectPath, "remote-fork", true]);
      expect(deleteWorkspace.mock.calls[0][5]).toEqual({ keepBranch: true });
      expect(persistedWorkspaceIds()).toEqual(["fffffffff1"]);
    });

    // #5114: a Coder fork marks its source as sharing the Coder workspace (existingWorkspace), so
    // deleting the source no longer deletes it. That mark and the child's row form one rollback
    // boundary: they are written together, and a rolled-back child undoes the mark.
    describe("Coder fork source runtime update (#5114)", () => {
      const sourceRuntimeConfig = {
        type: "ssh" as const,
        host: "coder-src.coder",
        srcBaseDir: "/remote/src",
        coder: { workspaceName: "coder-src", existingWorkspace: false },
      };
      const sourceId = "fffffffff5";
      const forkId = "ddddddddd5";
      const persistedRuntimeConfig = (id: string) =>
        [...harness.config.loadConfigOrDefault().projects.values()]
          .flatMap((project) => project.workspaces)
          .find((workspace) => workspace.id === id)?.runtimeConfig;

      /** Registers a new-mode Coder source and stubs the remote fork and delete. */
      async function setUpCoderFork() {
        const realCreateRuntime = runtimeFactory.createRuntime;
        // Coder runtimes need a CoderService; nothing on these paths calls it.
        const coderService = {} as unknown as CoderService;
        spyOn(runtimeFactory, "createRuntime").mockImplementation((config, options) =>
          realCreateRuntime(config, { ...options, coderService })
        );
        await harness.config.editConfig((cfg) => {
          cfg.projects.get(projectPath)!.workspaces.push({
            id: sourceId,
            name: "coder-src",
            path: "/remote/src/project/coder-src",
            runtimeConfig: sourceRuntimeConfig,
          });
          return cfg;
        });
        spyOn(harness.config, "generateStableId").mockReturnValueOnce(forkId);
        // CoderSSHRuntime.forkWorkspace wraps this and adds the shared (existingWorkspace) configs.
        spyOn(SSHRuntime.prototype, "forkWorkspace").mockResolvedValue({
          success: true,
          workspacePath: "/remote/src/project/coder-fork",
          sourceBranch: "coder-src",
        });
        spyOn(runtimeHelpers, "copyPlanFileAcrossRuntimes").mockResolvedValue(undefined);
        return spyOn(SSHRuntime.prototype, "deleteWorkspace").mockResolvedValue({
          success: true,
          deletedPath: "/remote/src/project/coder-fork",
        });
      }

      /** Forks the source with `duringSetup` run and then failing after the child registered. */
      async function failCoderForkAfterRegistration(duringSetup?: () => Promise<void>) {
        const deleteWorkspace = await setUpCoderFork();
        const goals = new WorkspaceGoalService(
          harness.config,
          harness.historyService,
          harness.extensionMetadata
        );
        service.setWorkspaceGoalService(goals);
        spyOn(goals, "inheritFromFork").mockImplementationOnce(async () => {
          // The child row and the source mark are persisted together at this point.
          expect(persistedWorkspaceIds()).toContain(forkId);
          expect(persistedRuntimeConfig(sourceId)).toMatchObject({
            coder: { existingWorkspace: true },
          });
          await duringSetup?.();
          throw new Error("goal store unavailable");
        });
        const result = await service.fork(sourceId, "coder-fork");
        expect(result.success ? "" : result.error).toContain("goal store unavailable");
        expect(deleteWorkspace).toHaveBeenCalledTimes(1);
        expect(persistedWorkspaceIds()).not.toContain(forkId);
      }

      test("a rejected registration write removes the fork's checkout and leaves the source unmarked", async () => {
        const deleteWorkspace = await setUpCoderFork();

        await expectFailsWithSaveError(() => service.fork(sourceId, "coder-fork"));

        expect(deleteWorkspace).toHaveBeenCalledTimes(1);
        expect(deleteWorkspace.mock.calls[0].slice(0, 3)).toEqual([
          projectPath,
          "coder-fork",
          true,
        ]);
        expect(persistedWorkspaceIds()).not.toContain(forkId);
        expect(persistedRuntimeConfig(sourceId)).toEqual(sourceRuntimeConfig);
      });

      test("a fork rolled back after registration restores the source's runtime config", async () => {
        await failCoderForkAfterRegistration();
        expect(persistedRuntimeConfig(sourceId)).toEqual(sourceRuntimeConfig);
      });

      test("a throwing source-metadata listener still rolls the fork back", async () => {
        const deleteWorkspace = await setUpCoderFork();
        service.on("metadata", (event: { workspaceId: string }) => {
          if (event.workspaceId === sourceId) throw new Error("listener failed");
        });

        const result = await service.fork(sourceId, "coder-fork");

        expect(result.success ? "" : result.error).toContain("listener failed");
        expect(deleteWorkspace).toHaveBeenCalledTimes(1);
        expect(persistedWorkspaceIds()).not.toContain(forkId);
        expect(persistedRuntimeConfig(sourceId)).toEqual(sourceRuntimeConfig);
      });

      test("the source stays marked while another workspace shares its Coder workspace", async () => {
        const sibling = {
          ...sourceRuntimeConfig,
          coder: { workspaceName: "coder-src", existingWorkspace: true },
        };
        await failCoderForkAfterRegistration(async () => {
          await harness.config.editConfig((cfg) => {
            cfg.projects.get(projectPath)!.workspaces.push({
              id: "eeeeeeeee5",
              name: "coder-sibling",
              path: "/remote/src/project/coder-sibling",
              runtimeConfig: sibling,
            });
            return cfg;
          });
        });
        expect(persistedRuntimeConfig(sourceId)).toMatchObject({
          coder: { workspaceName: "coder-src", existingWorkspace: true },
        });
      });

      test("the source keeps a runtime config that changed since the fork marked it", async () => {
        const changed = {
          ...sourceRuntimeConfig,
          coder: { workspaceName: "coder-src", existingWorkspace: true, template: "other" },
        };
        await failCoderForkAfterRegistration(() =>
          harness.config.updateWorkspaceMetadata(sourceId, { runtimeConfig: changed })
        );
        expect(persistedRuntimeConfig(sourceId)).toEqual(changed);
      });
    });

    // #5113: a new-mode Coder creation prepares a provisioning session (a short-lived deployment
    // token) in finalizeConfig; only init consumes it. A creation rolled back before init disposes
    // it, so the token does not linger and a retry cannot get it back.
    test("new-mode Coder creation whose registration write rejects disposes its provisioning session", async () => {
      const coderService = new CoderService();
      spyOn(coderService, "verifyAuthenticatedSession").mockResolvedValue(undefined);
      spyOn(coderService, "workspaceExists").mockResolvedValue(false);
      const tokenCommands = spyOn(disposableExec, "execFileAsync").mockImplementation(((
        file: string,
        args: string[]
      ) => {
        if (file !== "coder" || args[0] !== "tokens") {
          throw new Error(`Unexpected command: ${file} ${args.join(" ")}`);
        }
        const result = Promise.resolve({
          stdout: args[1] === "create" ? "token-1\n" : "",
          stderr: "",
        });
        return { result, child: {}, [Symbol.dispose]: () => undefined };
      }) as unknown as typeof disposableExec.execFileAsync);
      const realCreateRuntime = runtimeFactory.createRuntime;
      spyOn(runtimeFactory, "createRuntime").mockImplementation((config, options) =>
        realCreateRuntime(config, { ...options, coderService })
      );

      await expectFailsWithSaveError(() =>
        service.create(projectPath, "coder-new", "main", undefined, {
          type: "ssh",
          host: "coder",
          srcBaseDir: "/remote/src",
          coder: { template: "tmpl" },
        })
      );

      const tokenCalls = tokenCommands.mock.calls.map(([, args]) => args?.slice(0, 2).join(" "));
      expect(tokenCalls).toEqual(["tokens create", "tokens delete"]);
      expect(coderService.takeProvisioningSession("mux-coder-new")).toBeUndefined();
    });

    // #5117, Docker forks: the fork made its own container (DockerRuntime.forkWorkspace refuses a
    // name in use) before registering. The rollback removes it, and with it the fork's plan copy,
    // so no plan cleanup runs; a failed removal names the container, not the in-container path.
    describe("Docker fork rollback (#5117)", () => {
      const dockerFork = async (options: {
        deleteResult: Awaited<ReturnType<DockerRuntime["deleteWorkspace"]>>;
        copyFails?: boolean;
      }) => {
        const runtimeConfig = { type: "docker" as const, image: "ubuntu:24.04" };
        await harness.config.editConfig((cfg) => {
          cfg.projects.get(projectPath)!.workspaces.push({
            id: "fffffffff2",
            name: "docker-src",
            path: "/src",
            runtimeConfig,
          });
          return cfg;
        });
        const prototype = DockerRuntime.prototype;
        spyOn(prototype, "forkWorkspace").mockResolvedValue({
          success: true,
          workspacePath: "/src",
          sourceBranch: "docker-src",
        });
        const deleteWorkspace = spyOn(prototype, "deleteWorkspace").mockResolvedValue(
          options.deleteResult
        );
        const copyPlan = spyOn(runtimeHelpers, "copyPlanFileAcrossRuntimes");
        if (options.copyFails === true) {
          copyPlan.mockRejectedValueOnce(new Error("plan unreadable"));
        } else {
          copyPlan.mockResolvedValue("/var/mux/plans/project/docker-fork.md");
        }
        const publish = failConfigPublish();
        const result = await service
          .fork("fffffffff2", "docker-fork")
          .finally(() => publish.mockRestore());
        return { error: result.success ? "" : result.error, deleteWorkspace };
      };

      test("removes the fork's container and nothing else", async () => {
        const { error, deleteWorkspace } = await dockerFork({
          deleteResult: { success: true, deletedPath: "/src" },
        });
        expect(error).toContain("EROFS");
        expect(error).not.toContain("could not be fully cleaned up");
        expect(deleteWorkspace).toHaveBeenCalledTimes(1);
        expect(deleteWorkspace.mock.calls[0].slice(0, 3)).toEqual([
          projectPath,
          "docker-fork",
          true,
        ]);
        expect(persistedWorkspaceIds()).toEqual(["fffffffff2"]);
      });

      test.each([
        { label: "registration rollback", copyFails: false },
        { label: "copy-failure cleanup", copyFails: true },
      ])("$label names the container it could not remove", async ({ copyFails }) => {
        const { error } = await dockerFork({
          deleteResult: { success: false, error: "Failed to remove container: daemon down" },
          copyFails,
        });
        expect(error).toEndWith(
          leftoverSentence([`Docker container ${getContainerName(projectPath, "docker-fork")}`])
        );
      });
    });

    // #4936 gap 1: the multi-project runtime names the disposable paths it could not delete.
    test("multi-project fork names the checkout and container it could not delete", async () => {
      const sourceId = await createMultiSource();
      await initSettlements().get(sourceId);
      spyOn(WorktreeRuntime.prototype, "deleteWorkspace").mockRejectedValueOnce(new Error("EIO"));
      spyOn(ContainerManager.prototype, "removeContainer").mockRejectedValueOnce(
        new Error("EBUSY")
      );

      const publish = failConfigPublish();
      const result = await service
        .fork(sourceId, "multi-left")
        .finally(() => publish.mockRestore());
      const checkout = worktreePaths(projectPath).find((p) => path.basename(p) === "multi-left");
      expect(checkout).toBeDefined();
      // The other project's checkout was deleted, so it is not named.
      expect(worktreePaths(otherProjectPath).map((p) => path.basename(p))).not.toContain(
        "multi-left"
      );
      const container = path.join(srcBaseDir, "_workspaces", "multi-left");
      expect(result.success ? "" : result.error).toEndWith(
        leftoverSentence([checkout!, container])
      );
    });

    test("local multi-project fork never names a project's own repository", async () => {
      await harness.config.editConfig((cfg) => {
        cfg.projects.get(projectPath)!.workspaces.push({
          id: "eeeeeeeee1",
          name: "local-src",
          path: projectPath,
          runtimeConfig: { type: "local" },
          projects: projects(),
        });
        return cfg;
      });
      await fs.mkdir(path.join(harness.config.srcDir, "_workspaces", "local-src"), {
        recursive: true,
      });
      spyOn(runtimeHelpers, "copyPlanFileAcrossRuntimes").mockRejectedValueOnce(
        new Error("plan unreadable")
      );
      spyOn(LocalRuntime.prototype, "deleteWorkspace").mockRejectedValue(new Error("EIO"));
      spyOn(ContainerManager.prototype, "removeContainer").mockRejectedValueOnce(
        new Error("EBUSY")
      );

      const result = await service.fork("eeeeeeeee1", "local-fork");
      const container = path.join(harness.config.srcDir, "_workspaces", "local-fork");
      expect(result.success ? "" : result.error).toBe(
        `Failed to copy fork state: plan unreadable ${leftoverSentence([container])}`
      );
    });
  });
});
