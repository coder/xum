/**
 * Deterministic repros of the violations found by the TLA+ model in formal/workspace-lifecycle/
 * (run formal/workspace-lifecycle/check.sh). Each `test.failing` states the CORRECT contract and
 * fails today at its last assertion; its passing control runs the same steps on the path the code
 * already handles. When a fix lands the failing test starts passing, bun reports it, and the fix
 * should flip it to a plain `test`.
 *
 * Real Config, real git worktrees (an isolated GIT_CONFIG_GLOBAL), the default harness otherwise.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { execFileSync } from "child_process";
import cjsFs from "fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { MULTI_PROJECT_CONFIG_KEY } from "@/common/constants/multiProject";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import { WorktreeManager } from "@/node/worktree/WorktreeManager";
import * as crossProcessLock from "@/node/utils/main/crossProcessLock";
import type { ExperimentsService } from "./experimentsService";
import type { WorkspaceService } from "./workspaceService";
import { workspaceUseLeasesFor, type WorkspaceUseLease } from "./workspaceUseLeases";
import {
  createWorkspaceServiceHarness,
  type WorkspaceServiceHarness,
} from "./workspaceService.testHarness";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function branchExists(repoPath: string, branch: string): boolean {
  try {
    git(repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
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

/** A user branch one commit ahead of main, so only `git branch -D` deletes it. */
function userBranchWithOwnCommit(repoPath: string, branch: string): void {
  const tip = git(repoPath, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", `${branch} work`);
  git(repoPath, "branch", branch, tip);
}

function worktreeNames(repoPath: string): string[] {
  return git(repoPath, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.basename(line.slice("worktree ".length)));
}

/** Fail every config.json publish (the existing registration-rollback tests' fault). */
function failConfigPublish() {
  const realRename = cjsFs.rename.bind(cjsFs);
  return spyOn(cjsFs, "rename").mockImplementation(((
    from: cjsFs.PathLike,
    to: cjsFs.PathLike,
    callback: cjsFs.NoParamCallback
  ) => {
    if (path.basename(String(to)) === "config.json") {
      callback(Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" }));
      return;
    }
    realRename(from, to, callback);
  }) as typeof cjsFs.rename);
}

describe("workspace lifecycle (formal/workspace-lifecycle)", () => {
  let harness: WorkspaceServiceHarness;
  let service: WorkspaceService;
  let projectPath: string;
  let otherProjectPath: string;
  let srcBaseDir: string;
  let gitHome: string;
  const savedGitEnv = {
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  };

  beforeEach(async () => {
    gitHome = await fs.mkdtemp(path.join(os.tmpdir(), "lifecycle-formal-git-"));
    await fs.writeFile(path.join(gitHome, "gitconfig"), "");
    process.env.GIT_CONFIG_GLOBAL = path.join(gitHome, "gitconfig");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    harness = await createWorkspaceServiceHarness({
      experimentsService: {
        isExperimentEnabled: (id: string) => id === EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES,
      } as unknown as ExperimentsService,
    });
    service = harness.service;
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
    mock.restore();
    await harness.cleanup();
    for (const [key, value] of Object.entries(savedGitEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(gitHome, { recursive: true, force: true });
  });

  const createWorktree = (branch: string) =>
    service.create(
      projectPath,
      branch,
      "main",
      undefined,
      { type: "worktree", srcBaseDir },
      undefined,
      undefined,
      undefined,
      // Materialized: only then does create() take the registration lock (sanitizeAtRegistration).
      { awaitMaterialization: true }
    );

  // F1 (MC_lock_fault, NoOrphanCheckout; fixed). create() and fork() take the cross-process
  // registration lock after runtime.createWorkspace made the worktree and branch. Its timeout used
  // to land in the outer catch with no rollback armed, leaving both behind; it now undoes the
  // creation like a failed registration write, keeping a branch the creation only reused.
  describe("F1: registration lock failure after the checkout exists", () => {
    const failRegistrationLock = () => {
      const realAcquire = crossProcessLock.acquireCrossProcessLock;
      spyOn(crossProcessLock, "acquireCrossProcessLock").mockImplementation((options) =>
        path.basename(options.lockPath) === "workspace-registration.lock"
          ? Promise.reject(new Error("Another Mux process is currently registering a workspace."))
          : realAcquire(options)
      );
    };

    const createSource = async (): Promise<string> => {
      const source = await createWorktree("source");
      if (!source.success) throw new Error(source.error);
      return source.data.metadata.id;
    };

    test("create() removes the worktree and the branch it made", async () => {
      failRegistrationLock();

      const result = await createWorktree("feature-lock");
      expect(result.success).toBe(false);

      expect({
        worktree: worktreeNames(projectPath).includes("feature-lock"),
        branch: branchExists(projectPath, "feature-lock"),
      }).toEqual({ worktree: false, branch: false });
    });

    test("create() keeps a branch it reused", async () => {
      userBranchWithOwnCommit(projectPath, "feature-lock");
      failRegistrationLock();

      const result = await createWorktree("feature-lock");
      expect(result.success).toBe(false);

      expect({
        worktree: worktreeNames(projectPath).includes("feature-lock"),
        branch: branchExists(projectPath, "feature-lock"),
      }).toEqual({ worktree: false, branch: true });
    });

    test("fork() removes the worktree and the branch it made", async () => {
      const sourceId = await createSource();
      failRegistrationLock();

      const result = await service.fork(sourceId, "fork-lock");
      expect(result.success).toBe(false);

      expect({
        worktree: worktreeNames(projectPath).includes("fork-lock"),
        branch: branchExists(projectPath, "fork-lock"),
      }).toEqual({ worktree: false, branch: false });
      expect(worktreeNames(projectPath)).toContain("source");
    });

    test("fork() keeps a branch its explicit name reused", async () => {
      const sourceId = await createSource();
      userBranchWithOwnCommit(projectPath, "fork-lock");
      failRegistrationLock();

      const result = await service.fork(sourceId, "fork-lock");
      expect(result.success).toBe(false);

      expect({
        worktree: worktreeNames(projectPath).includes("fork-lock"),
        branch: branchExists(projectPath, "fork-lock"),
      }).toEqual({ worktree: false, branch: true });
    });

    test("control: a failed registration write undoes the same checkout", async () => {
      const publish = failConfigPublish();
      const result = await createWorktree("feature-lock").finally(() => publish.mockRestore());
      expect(result.success).toBe(false);

      expect({
        worktree: worktreeNames(projectPath).includes("feature-lock"),
        branch: branchExists(projectPath, "feature-lock"),
      }).toEqual({ worktree: false, branch: false });
    });
  });

  // F2 (MC_remove_retry, UserBranchSafe). A removal whose deregistration fails (:8083-8110)
  // keeps the row after runtime.deleteWorkspace already removed the worktree and the branch-map
  // entry (WorktreeManager.ts:852). The retry finds no map entry and falls back to the workspace
  // name as the branch name (WorktreeManager.ts:837, :1084): `git branch -D feature-x`.
  // Fixed: the fallback now needs git to still register the checkout on that branch. The
  // multi-project non-forced removal reaches the same state when a later project's delete fails.
  describe("F2: removal retry after a failed deregistration", () => {
    async function createOnSanitizedBranch(): Promise<string> {
      userBranchWithOwnCommit(projectPath, "feature-x"); // the user's own, unrelated branch
      const created = await createWorktree("feature/x");
      expect(created).toMatchObject({ success: true, data: { metadata: { name: "feature-x" } } });
      return created.success ? created.data.metadata.id : "";
    }

    test("the retry never deletes the user's branch named like the directory", async () => {
      const workspaceId = await createOnSanitizedBranch();
      spyOn(harness.config, "removeWorkspace").mockRejectedValueOnce(
        new Error("Timed out acquiring the config lock")
      );
      const first = await service
        .remove(workspaceId, true)
        .catch((error: unknown) => ({ success: false, error: String(error) }));
      expect(first.success).toBe(false);
      expect(branchExists(projectPath, "feature-x")).toBe(true);

      const retry = await service.remove(workspaceId, true);
      expect(retry.success).toBe(true);

      expect(branchExists(projectPath, "feature-x")).toBe(true);
    });

    test("a multi-project retry after a partial non-forced delete keeps that branch", async () => {
      // Merged into main: the non-forced removal's `git branch -d` would delete it.
      git(projectPath, "branch", "feature-x");
      const created = await service.createMultiProject(
        [
          { projectPath, projectName: "project" },
          { projectPath: otherProjectPath, projectName: "other" },
        ],
        "feature/x",
        "main",
        undefined,
        { type: "worktree", srcBaseDir }
      );
      expect(created).toMatchObject({ success: true, data: { name: "feature-x" } });
      const workspaceId = created.success ? created.data.id : "";
      expect(worktreeNames(projectPath)).toContain("feature-x");
      expect(worktreeNames(otherProjectPath)).toContain("feature-x");
      // The first project's checkout is deleted, then the second project's delete fails: the
      // non-forced removal returns an error and keeps the row (workspaceService.ts, multi-project).
      // eslint-disable-next-line @typescript-eslint/unbound-method -- called with the original receiver
      const realDelete = WorktreeManager.prototype.deleteWorkspace;
      let failOther = true;
      spyOn(WorktreeManager.prototype, "deleteWorkspace").mockImplementation(function (
        this: WorktreeManager,
        ...args: Parameters<WorktreeManager["deleteWorkspace"]>
      ) {
        return failOther && args[0] === otherProjectPath
          ? Promise.resolve({ success: false as const, error: "worktree is locked" })
          : realDelete.apply(this, args);
      });
      const first = await service.remove(workspaceId, false);
      failOther = false;
      expect(first.success).toBe(false);
      expect(worktreeNames(projectPath)).not.toContain("feature-x");
      expect(branchExists(projectPath, "feature-x")).toBe(true);

      const retry = await service.remove(workspaceId, false);
      expect(retry.success).toBe(true);
      expect(worktreeNames(otherProjectPath)).not.toContain("feature-x");

      expect(branchExists(projectPath, "feature-x")).toBe(true);
      expect(branchExists(projectPath, "feature/x")).toBe(false);
    });

    test("control: a removal that succeeds the first time keeps that branch", async () => {
      const workspaceId = await createOnSanitizedBranch();
      const removed = await service.remove(workspaceId, true);
      expect(removed.success).toBe(true);

      expect(branchExists(projectPath, "feature-x")).toBe(true);
      expect(branchExists(projectPath, "feature/x")).toBe(false);
    });
  });

  // F3 (MC_multi_p2fail, UserBranchSafe; fixed). When a later project's createWorkspace fails,
  // createMultiProject rolls back with rollbackCreatedWorkspaces() (forced = false), whose
  // keepBranch used to be `forced && !createdBranch`: false, so `git branch -d` removed a merged
  // user branch the first project merely reused. Every rollback now keeps such a branch.
  describe("F3: multi-project rollback after a later project fails", () => {
    const createMulti = () =>
      service.createMultiProject(
        [
          { projectPath, projectName: "project" },
          { projectPath: otherProjectPath, projectName: "other" },
        ],
        "shared",
        "main",
        undefined,
        { type: "worktree", srcBaseDir }
      );

    test("keeps the merged user branch the first project reused", async () => {
      git(projectPath, "branch", "shared"); // the user's branch, merged into main
      // The second project's checkout path is taken, so its createWorkspace fails.
      await fs.mkdir(path.join(srcBaseDir, "other", "shared"), { recursive: true });
      await fs.writeFile(path.join(srcBaseDir, "other", "shared", "keep.txt"), "user file\n");

      const result = await createMulti();
      expect(result.success).toBe(false);
      expect(worktreeNames(projectPath)).not.toContain("shared");

      expect(branchExists(projectPath, "shared")).toBe(true);
    });

    test("control: a failed registration write keeps that branch (forced rollback)", async () => {
      git(projectPath, "branch", "shared");
      const publish = failConfigPublish();
      const result = await createMulti().finally(() => publish.mockRestore());
      expect(result.success).toBe(false);
      expect(worktreeNames(projectPath)).not.toContain("shared");

      expect(branchExists(projectPath, "shared")).toBe(true);
    });
  });

  // F4 (MC_multi_meta, FailedNoGrant; fixed). createMultiProject used to mint unrelated-workspace
  // consent in the registration write itself, before the metadata read that can still fail. A
  // peer that discovered the consented row in that window started work there, so the rollback
  // kept the in-use row and the creation reported an error with consent granted. The write now
  // only marks the default pending, and the grant waits for publication, as in create().
  describe("F4: multi-project metadata read failure after a peer found the row", () => {
    const multiRow = () =>
      harness.config
        .loadConfigOrDefault()
        .projects.get(MULTI_PROJECT_CONFIG_KEY)
        ?.workspaces.find((workspace) => workspace.name === "shared");
    const leases: WorkspaceUseLease[] = [];
    afterEach(async () => {
      for (const lease of leases.splice(0)) await lease.release();
    });

    /**
     * Fail creation's own metadata read right after the registration write (once). Before it
     * fails, work starts on the row: a peer's turn, which needs the consent discovery shows
     * (task_list scope "instance"), or, with `anyUser`, a use that needs none (the UI).
     */
    const failMetadataReadAfterUse = (options: { anyUser: boolean }) => {
      const realGetAll = harness.config.getAllWorkspaceMetadata.bind(harness.config);
      let faulted = false;
      spyOn(harness.config, "getAllWorkspaceMetadata").mockImplementation(async () => {
        const row = multiRow();
        if (row?.id == null || faulted) return realGetAll();
        faulted = true;
        if (options.anyUser || row.unrelatedWorkspaceConsent != null) {
          leases.push(await workspaceUseLeasesFor(harness.config).hold(row.id, "turn"));
        }
        throw new Error("metadata read failed");
      });
    };

    const createMulti = () =>
      service.createMultiProject(
        [
          { projectPath, projectName: "project" },
          { projectPath: otherProjectPath, projectName: "other" },
        ],
        "shared",
        "main",
        undefined,
        { type: "worktree", srcBaseDir }
      );

    test("the failed creation never grants unrelated-workspace consent", async () => {
      failMetadataReadAfterUse({ anyUser: false });
      const result = await createMulti();
      expect(result.success).toBe(false);

      expect(multiRow()?.unrelatedWorkspaceConsent).toBeUndefined();
    });

    test("a row kept because it is in use keeps neither consent nor its pending mark", async () => {
      failMetadataReadAfterUse({ anyUser: true });
      const result = await createMulti();
      expect(result.success).toBe(false);

      expect(multiRow()).toMatchObject({ name: "shared" });
      expect(multiRow()?.unrelatedWorkspaceConsent).toBeUndefined();
      expect(multiRow()?.unrelatedWorkspaceConsentPending).toBeUndefined();
    });
  });
});
