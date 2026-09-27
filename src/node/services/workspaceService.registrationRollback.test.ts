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
});
