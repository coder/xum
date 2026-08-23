import { describe, expect, it, spyOn } from "bun:test";
import * as os from "os";
import * as path from "path";
import * as fsPromises from "fs/promises";
import { execSync } from "node:child_process";
import * as disposableExec from "@/node/utils/disposableExec";
import type { InitLogger } from "@/node/runtime/Runtime";
import * as submoduleSync from "@/node/runtime/submoduleSync";
import { WorktreeManager } from "./WorktreeManager";

function initGitRepo(projectPath: string): void {
  execSync("git init -b main", { cwd: projectPath, stdio: "ignore" });
  execSync('git config user.email "test@example.com"', { cwd: projectPath, stdio: "ignore" });
  execSync('git config user.name "test"', { cwd: projectPath, stdio: "ignore" });
  // Ensure tests don't hang when developers have global commit signing enabled.
  execSync("git config commit.gpgsign false", { cwd: projectPath, stdio: "ignore" });
  execSync("bash -lc 'echo \"hello\" > README.md'", { cwd: projectPath, stdio: "ignore" });
  execSync("git add README.md", { cwd: projectPath, stdio: "ignore" });
  execSync('git commit -m "init"', { cwd: projectPath, stdio: "ignore" });
}

function createNullInitLogger(): InitLogger {
  return {
    logStep: (_message: string) => undefined,
    logStdout: (_line: string) => undefined,
    logStderr: (_line: string) => undefined,
    logComplete: (_exitCode: number) => undefined,
  };
}

async function createWorktreeManagerFixture(options?: {
  existingBranchName?: string;
  currentBranchName?: string;
  tempDirPrefix?: string;
}) {
  const rootDir = await fsPromises.realpath(
    await fsPromises.mkdtemp(
      path.join(os.tmpdir(), options?.tempDirPrefix ?? "worktree-manager-create-")
    )
  );
  const projectPath = path.join(rootDir, "repo");
  await fsPromises.mkdir(projectPath, { recursive: true });
  initGitRepo(projectPath);

  if (options?.currentBranchName) {
    execSync(`git checkout -b ${options.currentBranchName}`, { cwd: projectPath, stdio: "ignore" });
  }

  if (options?.existingBranchName) {
    execSync(`git branch ${options.existingBranchName}`, { cwd: projectPath, stdio: "ignore" });
  }

  const srcBaseDir = path.join(rootDir, "src");
  await fsPromises.mkdir(srcBaseDir, { recursive: true });

  return {
    rootDir,
    projectPath,
    manager: new WorktreeManager(srcBaseDir),
    initLogger: createNullInitLogger(),
    cleanup: () => fsPromises.rm(rootDir, { recursive: true, force: true }),
  };
}

describe("WorktreeManager constructor", () => {
  it("should expand tilde in srcBaseDir", () => {
    const manager = new WorktreeManager("~/workspace");
    const workspacePath = manager.getWorkspacePath("/home/user/project", "branch");

    // The workspace path should use the expanded home directory
    const expected = path.join(os.homedir(), "workspace", "project", "branch");
    expect(workspacePath).toBe(expected);
  });

  it("should handle absolute paths without expansion", () => {
    const manager = new WorktreeManager("/absolute/path");
    const workspacePath = manager.getWorkspacePath("/home/user/project", "branch");

    const expected = path.join("/absolute/path", "project", "branch");
    expect(workspacePath).toBe(expected);
  });

  it("should handle bare tilde", () => {
    const manager = new WorktreeManager("~");
    const workspacePath = manager.getWorkspacePath("/home/user/project", "branch");

    const expected = path.join(os.homedir(), "project", "branch");
    expect(workspacePath).toBe(expected);
  });
});

describe("WorktreeManager.createWorkspace", () => {
  const rollbackCases = [
    {
      name: "rolls back failed new worktrees when submodule materialization fails",
      branchName: "feature-rollback",
      existingBranchName: undefined,
      expectedBranchAfter: "",
    },
    {
      name: "preserves existing branches when rollback removes a failed worktree",
      branchName: "feature-existing",
      existingBranchName: "feature-existing",
      expectedBranchAfter: "feature-existing",
    },
  ] as const;

  for (const testCase of rollbackCases) {
    it(
      testCase.name,
      async () => {
        const fixture = await createWorktreeManagerFixture({
          existingBranchName: testCase.existingBranchName,
        });

        try {
          const workspacePath = fixture.manager.getWorkspacePath(
            fixture.projectPath,
            testCase.branchName
          );
          const syncSpy = spyOn(submoduleSync, "syncLocalGitSubmodules").mockImplementation(() =>
            Promise.reject(new Error("submodule auth failed"))
          );

          try {
            const result = await fixture.manager.createWorkspace({
              projectPath: fixture.projectPath,
              branchName: testCase.branchName,
              trunkBranch: "main",
              initLogger: fixture.initLogger,
              trusted: true,
            });

            expect(result.success).toBe(false);
            if (result.success) {
              throw new Error("Expected createWorkspace to fail");
            }
            expect(result.error).toContain("submodule auth failed");

            let workspaceExists = true;
            try {
              await fsPromises.access(workspacePath);
            } catch {
              workspaceExists = false;
            }
            expect(workspaceExists).toBe(false);

            const branchAfter = execSync(`git branch --list "${testCase.branchName}"`, {
              cwd: fixture.projectPath,
              stdio: ["ignore", "pipe", "ignore"],
            })
              .toString()
              .trim();
            expect(branchAfter).toBe(testCase.expectedBranchAfter);
          } finally {
            syncSpy.mockRestore();
          }
        } finally {
          await fixture.cleanup();
        }
      },
      20_000
    );
  }
  it("uses a sanitized directory for slash branch names and persists the mapping", async () => {
    const fixture = await createWorktreeManagerFixture();
    const branchName = "feature/foo";
    const directoryName = "feature-foo";

    try {
      const result = await fixture.manager.createWorkspace({
        projectPath: fixture.projectPath,
        branchName,
        directoryName,
        trunkBranch: "main",
        initLogger: fixture.initLogger,
        trusted: true,
      });

      expect(result.success).toBe(true);
      if (!result.success || !result.workspacePath) {
        throw new Error("Expected createWorkspace to return a workspace path");
      }

      expect(result.workspacePath).toBe(
        fixture.manager.getWorkspacePath(fixture.projectPath, directoryName)
      );
      const nestedBranchDirectoryExists = await fsPromises
        .access(fixture.manager.getWorkspacePath(fixture.projectPath, "feature"))
        .then(
          () => true,
          () => false
        );
      expect(nestedBranchDirectoryExists).toBe(false);

      const checkedOutBranch = execSync("git branch --show-current", {
        cwd: result.workspacePath,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      expect(checkedOutBranch).toBe(branchName);

      const branchMapPath = path.join(fixture.projectPath, ".git", "mux-workspace-branches.json");
      const branchMap = JSON.parse(await fsPromises.readFile(branchMapPath, "utf8")) as Record<
        string,
        string
      >;
      expect(branchMap[directoryName]).toBe(branchName);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);
});

describe("WorktreeManager.renameWorkspace", () => {
  it("does not rename unrelated branches when the workspace tracks a different branch", async () => {
    const fixture = await createWorktreeManagerFixture();

    try {
      const { projectPath, manager, initLogger } = fixture;
      const branchName = "feature-branch";
      const oldName = "review-slot";
      const newName = "renamed-slot";
      const createResult = await manager.createWorkspace({
        projectPath,
        branchName,
        directoryName: oldName,
        trunkBranch: "main",
        initLogger,
        trusted: true,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;

      execSync(`git branch ${oldName}`, { cwd: projectPath, stdio: "ignore" });

      const renameResult = await manager.renameWorkspace(projectPath, oldName, newName, true);
      expect(renameResult.success).toBe(true);

      const trackedBranchAfter = execSync(`git branch --list "${branchName}"`, {
        cwd: projectPath,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      expect(trackedBranchAfter).toContain(branchName);

      const unrelatedBranchAfter = execSync(`git branch --list "${oldName}"`, {
        cwd: projectPath,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      expect(unrelatedBranchAfter).toContain(oldName);

      const newNameBranchAfter = execSync(`git branch --list "${newName}"`, {
        cwd: projectPath,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      expect(newNameBranchAfter).toBe("");
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);
});

describe("WorktreeManager.deleteWorkspace", () => {
  it("deletes non-agent branches when removing worktrees (force)", async () => {
    const fixture = await createWorktreeManagerFixture({
      tempDirPrefix: "worktree-manager-delete-",
    });

    try {
      const { projectPath, manager, initLogger } = fixture;

      const branchName = "feature_aaaaaaaaaa";
      const createResult = await manager.createWorkspace({
        projectPath,
        branchName,
        trunkBranch: "main",
        initLogger,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;
      if (!createResult.workspacePath) {
        throw new Error("Expected workspacePath from createWorkspace");
      }
      const workspacePath = createResult.workspacePath;

      // Make the branch unmerged (so -d would fail); force delete should still delete it.
      execSync("bash -lc 'echo \"change\" >> README.md'", {
        cwd: workspacePath,
        stdio: "ignore",
      });
      execSync("git add README.md", { cwd: workspacePath, stdio: "ignore" });
      execSync('git commit -m "change"', { cwd: workspacePath, stdio: "ignore" });

      const deleteResult = await manager.deleteWorkspace(projectPath, branchName, true);
      expect(deleteResult.success).toBe(true);

      const after = execSync(`git branch --list "${branchName}"`, {
        cwd: projectPath,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      expect(after).toBe("");
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("force-delete fallback does not execute shell payloads embedded in branch names", async () => {
    const fixture = await createWorktreeManagerFixture({
      tempDirPrefix: "worktree-manager-delete-",
    });
    const sentinelPath = path.join(
      os.tmpdir(),
      `mux_injection_test_${Date.now()}_${Math.random().toString(16).slice(2)}`
    );
    const branchName = `feature/inject-$(touch\${IFS}${sentinelPath})`;

    let execFileAsyncSpy: { mockRestore: () => void } | null = null;

    try {
      const { projectPath, manager, initLogger } = fixture;

      const createResult = await manager.createWorkspace({
        projectPath,
        branchName,
        trunkBranch: "main",
        initLogger,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;
      if (!createResult.workspacePath) {
        throw new Error("Expected workspacePath from createWorkspace");
      }
      const workspacePath = createResult.workspacePath;

      const originalExecFileAsync = disposableExec.execFileAsync;
      execFileAsyncSpy = spyOn(disposableExec, "execFileAsync").mockImplementation(
        (file, args, options) => {
          if (file === "git" && args[2] === "worktree" && args[3] === "remove") {
            return originalExecFileAsync("git", ["definitely-invalid-command"]);
          }

          return originalExecFileAsync(file, args, options);
        }
      );

      const deleteResult = await manager.deleteWorkspace(projectPath, branchName, true);
      expect(deleteResult.success).toBe(true);

      let workspaceExists = true;
      try {
        await fsPromises.access(workspacePath);
      } catch {
        workspaceExists = false;
      }
      expect(workspaceExists).toBe(false);

      let sentinelExists = true;
      try {
        await fsPromises.access(sentinelPath);
      } catch {
        sentinelExists = false;
      }
      expect(sentinelExists).toBe(false);
    } finally {
      execFileAsyncSpy?.mockRestore();
      await fsPromises.rm(sentinelPath, { force: true });
      await fixture.cleanup();
    }
  }, 20_000);

  it("deletes the checked-out branch instead of the workspace directory name", async () => {
    const fixture = await createWorktreeManagerFixture({
      tempDirPrefix: "worktree-manager-delete-",
    });

    try {
      const { projectPath, manager, initLogger } = fixture;

      const branchName = "feature-dir-split";
      const directoryName = "review-slot";
      const createResult = await manager.createWorkspace({
        projectPath,
        branchName,
        directoryName,
        trunkBranch: "main",
        initLogger,
        trusted: true,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;

      execSync(`git branch ${directoryName}`, { cwd: projectPath, stdio: "ignore" });
      execSync("git checkout -b temp-checkout", {
        cwd: createResult.workspacePath,
        stdio: "ignore",
      });

      const deleteResult = await manager.deleteWorkspace(projectPath, directoryName, true);
      expect(deleteResult.success).toBe(true);

      const featureBranchAfter = execSync(`git branch --list "${branchName}"`, {
        cwd: projectPath,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      expect(featureBranchAfter).toBe("");

      const directoryBranchAfter = execSync(`git branch --list "${directoryName}"`, {
        cwd: projectPath,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      expect(directoryBranchAfter).toBe(directoryName);

      const tempBranchAfter = execSync('git branch --list "temp-checkout"', {
        cwd: projectPath,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      expect(tempBranchAfter).toBe("temp-checkout");
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("uses the persisted workspace branch when branch lookup is unavailable", async () => {
    const fixture = await createWorktreeManagerFixture({
      tempDirPrefix: "worktree-manager-delete-",
    });

    try {
      const { rootDir, projectPath: mainProjectPath, manager, initLogger } = fixture;
      const linkedProjectPath = path.join(rootDir, "source-worktree");
      execSync(`git worktree add -b source-worktree "${linkedProjectPath}"`, {
        cwd: mainProjectPath,
        stdio: "ignore",
      });

      const branchName = "feature-missing-branch";
      const directoryName = "review-slot-missing";
      const createResult = await manager.createWorkspace({
        projectPath: linkedProjectPath,
        branchName,
        directoryName,
        trunkBranch: "main",
        initLogger,
        trusted: true,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success || !createResult.workspacePath) {
        throw new Error("Expected workspacePath from createWorkspace");
      }

      execSync(`git branch ${directoryName}`, { cwd: linkedProjectPath, stdio: "ignore" });
      await fsPromises.rm(createResult.workspacePath, { recursive: true, force: true });
      execSync("git worktree prune", { cwd: linkedProjectPath, stdio: "ignore" });

      const deleteResult = await manager.deleteWorkspace(linkedProjectPath, directoryName, true);
      expect(deleteResult.success).toBe(true);

      const featureBranchAfter = execSync(`git branch --list "${branchName}"`, {
        cwd: linkedProjectPath,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      expect(featureBranchAfter).toBe("");

      const directoryBranchAfter = execSync(`git branch --list "${directoryName}"`, {
        cwd: linkedProjectPath,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      expect(directoryBranchAfter).toBe(directoryName);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("falls back to the workspace name when this workspace has no branch map entry", async () => {
    const fixture = await createWorktreeManagerFixture({
      tempDirPrefix: "worktree-manager-delete-",
    });

    try {
      const { projectPath, manager, initLogger } = fixture;
      const workspaceName = "feature-legacy-workspace";
      const createResult = await manager.createWorkspace({
        projectPath,
        branchName: workspaceName,
        trunkBranch: "main",
        initLogger,
        trusted: true,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success || !createResult.workspacePath) {
        throw new Error("Expected workspacePath from createWorkspace");
      }

      const survivingWorkspace = await manager.createWorkspace({
        projectPath,
        branchName: "feature-mapped-workspace",
        trunkBranch: "main",
        initLogger,
        trusted: true,
      });
      expect(survivingWorkspace.success).toBe(true);
      const branchMapPath = path.join(projectPath, ".git", "mux-workspace-branches.json");
      const branchMap = JSON.parse(await fsPromises.readFile(branchMapPath, "utf8")) as Record<
        string,
        string
      >;
      delete branchMap[workspaceName];
      await fsPromises.writeFile(branchMapPath, `${JSON.stringify(branchMap, null, 2)}\n`);

      await fsPromises.rm(createResult.workspacePath, { recursive: true, force: true });
      execSync("git worktree prune", { cwd: projectPath, stdio: "ignore" });

      const deleteResult = await manager.deleteWorkspace(projectPath, workspaceName, true);
      expect(deleteResult.success).toBe(true);

      const branchAfter = execSync(`git branch --list "${workspaceName}"`, {
        cwd: projectPath,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      expect(branchAfter).toBe("");
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("deletes merged branches when removing worktrees (safe delete)", async () => {
    const fixture = await createWorktreeManagerFixture({
      tempDirPrefix: "worktree-manager-delete-",
    });

    try {
      const { projectPath, manager, initLogger } = fixture;

      const branchName = "feature_merge_aaaaaaaaaa";
      const createResult = await manager.createWorkspace({
        projectPath,
        branchName,
        trunkBranch: "main",
        initLogger,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;
      if (!createResult.workspacePath) {
        throw new Error("Expected workspacePath from createWorkspace");
      }
      const workspacePath = createResult.workspacePath;

      // Commit on the workspace branch.
      execSync("bash -lc 'echo \"merged-change\" >> README.md'", {
        cwd: workspacePath,
        stdio: "ignore",
      });
      execSync("git add README.md", { cwd: workspacePath, stdio: "ignore" });
      execSync('git commit -m "merged-change"', {
        cwd: workspacePath,
        stdio: "ignore",
      });

      // Merge into main so `git branch -d` succeeds.
      execSync(`git merge "${branchName}"`, { cwd: projectPath, stdio: "ignore" });

      const deleteResult = await manager.deleteWorkspace(projectPath, branchName, false);
      expect(deleteResult.success).toBe(true);

      const after = execSync(`git branch --list "${branchName}"`, {
        cwd: projectPath,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      expect(after).toBe("");
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("does not delete protected branches", async () => {
    const fixture = await createWorktreeManagerFixture({
      currentBranchName: "other",
      tempDirPrefix: "worktree-manager-delete-",
    });

    try {
      const { projectPath, manager, initLogger } = fixture;

      const branchName = "main";
      const createResult = await manager.createWorkspace({
        projectPath,
        branchName,
        trunkBranch: "main",
        initLogger,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;
      if (!createResult.workspacePath) {
        throw new Error("Expected workspacePath from createWorkspace");
      }
      const workspacePath = createResult.workspacePath;

      const deleteResult = await manager.deleteWorkspace(projectPath, branchName, true);
      expect(deleteResult.success).toBe(true);

      // The worktree directory should be removed.
      let worktreeExists = true;
      try {
        await fsPromises.access(workspacePath);
      } catch {
        worktreeExists = false;
      }
      expect(worktreeExists).toBe(false);

      // But protected branches (like main) should never be deleted.
      const after = execSync(`git branch --list "${branchName}"`, {
        cwd: projectPath,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      expect(after).toBe("main");
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);
});
