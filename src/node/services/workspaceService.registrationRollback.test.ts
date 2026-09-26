import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { execFileSync } from "child_process";
import cjsFs from "fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { Result } from "@/common/types/result";
import type { ExperimentsService } from "./experimentsService";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import type { InitStateManager } from "./initStateManager";
import type { WorkspaceService } from "./workspaceService";
import {
  createWorkspaceServiceHarness,
  type WorkspaceServiceHarness,
} from "./workspaceService.testHarness";

/**
 * #4745: when the registration config edit rejects, create/fork/rename must undo what they made
 * on disk and in memory, return the original error, and leave the next attempt unobstructed.
 * Real Config, real git worktrees; only the rename that publishes config.json fails (#4752).
 */
function failConfigPublish() {
  const realRename = cjsFs.rename.bind(cjsFs);
  return spyOn(cjsFs, "rename").mockImplementation(((
    from: cjsFs.PathLike,
    to: cjsFs.PathLike,
    callback: cjsFs.NoParamCallback
  ) => {
    if (path.basename(String(to)) === "config.json") {
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

  // The deferred rollback force-removes the unpopulated checkout; that must never reach a
  // branch the creation did not make (a forced delete runs `git branch -D`).
  test("deferred create on an existing branch never deletes that branch", async () => {
    git(projectPath, "checkout", "-q", "-b", "existing");
    git(projectPath, "commit", "-q", "--allow-empty", "-m", "unmerged work");
    const tip = git(projectPath, "rev-parse", "existing");
    git(projectPath, "checkout", "-q", "main");

    await expectFailsWithSaveError(() => createWorktree("existing", false));
    expect(git(projectPath, "rev-parse", "existing")).toBe(tip);
  });

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

    const retry = await service.rename(id, "after");
    expect(retry.success).toBe(true);
    expect((await harness.config.getWorkspaceMetadataById(id))?.name).toBe("after");
  });

  test("multi-project rename moves every checkout and the container back", async () => {
    const created = await service.createMultiProject(
      projects(),
      "multi-before",
      "main",
      undefined,
      { type: "worktree", srcBaseDir }
    );
    if (!created.success) throw new Error(created.error);
    const { id, namedWorkspacePath: oldContainer } = created.data;
    const checkoutsBefore = [worktreePaths(projectPath), worktreePaths(otherProjectPath)];

    await expectFailsWithSaveError(() => service.rename(id, "multi-after"));
    expect([worktreePaths(projectPath), worktreePaths(otherProjectPath)]).toEqual(checkoutsBefore);
    expect(await exists(path.join(oldContainer, "project", "README.md"))).toBe(true);
    expect(await exists(path.join(path.dirname(oldContainer), "multi-after"))).toBe(false);

    expect((await service.rename(id, "multi-after")).success).toBe(true);
  });
});
