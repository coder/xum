/**
 * Integration tests for workspace deletion across Local and SSH runtimes
 *
 * Tests WORKSPACE_REMOVE IPC handler with both LocalRuntime (git worktrees)
 * and SSHRuntime (plain directories), including force flag and submodule handling.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import {
  createTestEnvironment,
  cleanupTestEnvironment,
  shouldRunIntegrationTests,
  type TestEnvironment,
} from "../setup";
import {
  createTempGitRepo,
  cleanupTempGitRepo,
  generateBranchName,
  addSubmodule,
  waitForFileNotExists,
  createStreamCollector,
  waitFor,
  createWorkspaceWithInit,
  TEST_TIMEOUT_LOCAL_MS,
  TEST_TIMEOUT_SSH_MS,
  getTestRunner,
} from "../helpers";
import {
  isDockerAvailable,
  startSSHServer,
  stopSSHServer,
  type SSHServerConfig,
} from "../../runtime/test-fixtures/ssh-fixture";
import type { RuntimeConfig } from "../../../src/common/types/runtime";
import { sshConnectionPool } from "../../../src/node/runtime/sshConnectionPool";
import { ssh2ConnectionPool } from "../../../src/node/runtime/SSH2ConnectionPool";
import { execAsync } from "../../../src/node/utils/disposableExec";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// SSH server config (shared across all SSH tests)
let sshConfig: SSHServerConfig | undefined;

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Execute bash command in workspace context (works for both local and SSH)
 */
async function executeBash(
  env: TestEnvironment,
  workspaceId: string,
  command: string
): Promise<{ output: string; exitCode: number }> {
  const result = await env.orpc.workspace.executeBash({ workspaceId, script: command });

  if (!result.success || !result.data) {
    const errorMessage = "error" in result ? result.error : "unknown error";
    throw new Error(
      `Bash execution failed for "${command}" (workspace=${workspaceId}): ${errorMessage}`
    );
  }

  const bashResult = result.data;
  return { output: bashResult.output ?? "", exitCode: bashResult.exitCode };
}

/**
 * Check if workspace directory exists (runtime-agnostic)
 * This verifies the workspace root directory exists
 */
async function workspaceExists(env: TestEnvironment, workspaceId: string): Promise<boolean> {
  try {
    // Try to execute a simple command in the workspace
    // If workspace doesn't exist, this will fail
    const result = await executeBash(env, workspaceId, `pwd`);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Make workspace dirty by modifying a tracked file (runtime-agnostic)
 */
async function makeWorkspaceDirty(env: TestEnvironment, workspaceId: string): Promise<void> {
  // Modify an existing tracked file (README.md exists in test repos)
  // This ensures git will detect uncommitted changes
  await executeBash(
    env,
    workspaceId,
    'echo "test modification to make workspace dirty" >> README.md'
  );
}

/**
 * Create a temporary git repo with a committed .mux/init hook.
 *
 * The hook must be committed so SSH runtimes (which sync via git) receive it.
 */
async function createTempGitRepoWithInitHook(customScript: string): Promise<string> {
  const repoPath = await createTempGitRepo();

  const muxDir = path.join(repoPath, ".mux");
  await fs.mkdir(muxDir, { recursive: true });

  const hookPath = path.join(muxDir, "init");
  const scriptContent = `#!/bin/bash\nset -euo pipefail\n${customScript}\n`;
  await fs.writeFile(hookPath, scriptContent, { mode: 0o755 });

  // Commit the init hook so SSH runtimes see it after sync.
  using commitProc = execAsync(
    `git -C "${repoPath}" add -A && git -C "${repoPath}" -c commit.gpgsign=false commit -m "Add init hook"`
  );
  await commitProc.result;

  return repoPath;
}

async function executeSSH(command: string): Promise<string> {
  if (!sshConfig) {
    throw new Error("SSH config not ready");
  }

  using proc = execAsync(
    `ssh -i "${sshConfig.privateKeyPath}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=2 -p ${sshConfig.port} testuser@localhost '${command}'`
  );
  const { stdout } = await proc.result;
  return stdout.trim();
}

async function clearMarkerFile(runtimeType: "local" | "ssh", markerPath: string): Promise<void> {
  if (runtimeType === "ssh") {
    // Quote paths to avoid surprises if markerPath contains spaces or glob chars.
    await executeSSH(`rm -f -- "${markerPath}"`);
    return;
  }

  await fs.rm(markerPath, { force: true });
}

async function markerFileExists(
  runtimeType: "local" | "ssh",
  markerPath: string
): Promise<boolean> {
  if (runtimeType === "ssh") {
    const result = await executeSSH(`if [ -f "${markerPath}" ]; then echo yes; else echo no; fi`);
    return result === "yes";
  }

  try {
    await fs.access(markerPath);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Test Suite
// ============================================================================

describeIntegration("Workspace deletion integration tests", () => {
  beforeAll(async () => {
    // Check if Docker is available (required for SSH tests)
    if (!(await isDockerAvailable())) {
      throw new Error(
        "Docker is required for SSH runtime tests. Please install Docker or skip tests by unsetting TEST_INTEGRATION."
      );
    }

    // Start SSH server (shared across all tests for speed)
    console.log("Starting SSH server container for deletion tests...");
    sshConfig = await startSSHServer();
    console.log(`SSH server ready on port ${sshConfig.port}`);
  }, 60000);

  afterAll(async () => {
    if (sshConfig) {
      console.log("Stopping SSH server container...");
      await stopSSHServer(sshConfig);
    }
  }, 30000);

  // Reset SSH connection pool state before each test to prevent backoff from one
  // test affecting subsequent tests. This allows tests to run concurrently.
  beforeEach(() => {
    sshConnectionPool.clearAllHealth();
    ssh2ConnectionPool.clearAllHealth();
  });

  // Test matrix: Run tests for both local and SSH runtimes
  describe.each<{ type: "local" | "ssh" }>([{ type: "local" }, { type: "ssh" }])(
    "Runtime: $type",
    ({ type }) => {
      const TEST_TIMEOUT = type === "ssh" ? TEST_TIMEOUT_SSH_MS : TEST_TIMEOUT_LOCAL_MS;

      // SSH tests run serially to avoid Docker container overload
      const runTest = getTestRunner(type);

      // Helper to build runtime config
      const getRuntimeConfig = (_branchName: string): RuntimeConfig | undefined => {
        if (type === "ssh" && sshConfig) {
          return {
            type: "ssh",
            host: `testuser@localhost`,
            srcBaseDir: sshConfig.workdir, // Base workdir, not including branch name
            identityFile: sshConfig.privateKeyPath,
            port: sshConfig.port,
          };
        }
        return undefined; // undefined = defaults to local
      };

      runTest(
        "should successfully delete workspace",
        async () => {
          const env = await createTestEnvironment();
          const tempGitRepo = await createTempGitRepo();

          try {
            const branchName = generateBranchName("delete-test");
            const runtimeConfig = getRuntimeConfig(branchName);
            const { workspaceId, workspacePath } = await createWorkspaceWithInit(
              env,
              tempGitRepo,
              branchName,
              runtimeConfig,
              true, // waitForInit
              type === "ssh"
            );

            // Verify workspace exists (works for both local and SSH)
            const existsBefore = await workspaceExists(env, workspaceId);
            if (!existsBefore) {
              console.error(`Workspace ${workspaceId} does not exist after creation`);
              console.error(`workspacePath from metadata: ${workspacePath}`);
            }
            expect(existsBefore).toBe(true);

            // Delete the workspace
            const deleteResult = await env.orpc.workspace.remove({ workspaceId });

            if (!deleteResult.success) {
              console.error("Delete failed:", deleteResult.error);
            }
            expect(deleteResult.success).toBe(true);

            // Local worktree runtime should also delete the local branch.
            if (type === "local") {
              using branchProc = execAsync(`git -C "${tempGitRepo}" branch --list "${branchName}"`);
              const { stdout } = await branchProc.result;
              expect(stdout.trim()).toBe("");
            }

            // Verify workspace is no longer in config
            const config = env.config.loadConfigOrDefault();
            const project = config.projects.get(tempGitRepo);
            if (project) {
              const stillInConfig = project.workspaces.some((w) => w.id === workspaceId);
              expect(stillInConfig).toBe(false);
            }
          } finally {
            await cleanupTestEnvironment(env);
            await cleanupTempGitRepo(tempGitRepo);
          }
        },
        TEST_TIMEOUT
      );

      runTest(
        "force remove during init should delete workspace and cancel init",
        async () => {
          const env = await createTestEnvironment();
          const branchName = generateBranchName("remove-during-init");

          const markerPath =
            type === "ssh"
              ? `/home/testuser/mux-init-cancel-${branchName}`
              : path.join(os.tmpdir(), `mux-init-cancel-${branchName}`);

          const sleepSeconds = 5;
          const tempGitRepo = await createTempGitRepoWithInitHook(
            `echo HOOK_STARTED\nsleep ${sleepSeconds}\necho done > \"${markerPath}\"`
          );

          try {
            await clearMarkerFile(type, markerPath);

            const runtimeConfig = getRuntimeConfig(branchName);
            const { workspaceId } = await createWorkspaceWithInit(
              env,
              tempGitRepo,
              branchName,
              runtimeConfig,
              false, // waitForInit
              type === "ssh"
            );

            const collector = createStreamCollector(env.orpc, workspaceId);
            collector.start();

            try {
              await collector.waitForSubscription(type === "ssh" ? 20000 : 10000);

              const sawHookStarted = await waitFor(
                () =>
                  collector.getEvents().some((event) => {
                    return (
                      "type" in event &&
                      event.type === "init-output" &&
                      typeof event.line === "string" &&
                      event.line.includes("HOOK_STARTED")
                    );
                  }),
                type === "ssh" ? 20000 : 15000
              );

              expect(sawHookStarted).toBe(true);

              // Stop collecting before removal to reduce noisy subscription errors when the
              // workspace disappears mid-stream.
              collector.stop();

              const removeResult = await env.orpc.workspace.remove({
                workspaceId,
                options: { force: true },
              });
              expect(removeResult.success).toBe(true);

              // Verify workspace is no longer in config
              const config = env.config.loadConfigOrDefault();
              const project = config.projects.get(tempGitRepo);
              if (project) {
                const stillInConfig = project.workspaces.some((w) => w.id === workspaceId);
                expect(stillInConfig).toBe(false);
              }

              // Local worktree runtime should also delete the local branch.
              if (type === "local") {
                using branchProc = execAsync(
                  `git -C "${tempGitRepo}" branch --list "${branchName}"`
                );
                const { stdout } = await branchProc.result;
                expect(stdout.trim()).toBe("");
              }

              // Wait long enough that the init hook would have written the marker if it wasn't aborted.
              // Poll (instead of sleeping once) so failures show up as soon as the marker appears.
              const pollIntervalMs = type === "ssh" ? 1000 : 250;
              const deadline = Date.now() + (sleepSeconds + 2) * 1000;
              while (Date.now() < deadline) {
                expect(await markerFileExists(type, markerPath)).toBe(false);
                await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
              }

              expect(await markerFileExists(type, markerPath)).toBe(false);
              expect(await workspaceExists(env, workspaceId)).toBe(false);
            } finally {
              collector.stop();
            }
          } finally {
            await clearMarkerFile(type, markerPath);
            await cleanupTestEnvironment(env);
            await cleanupTempGitRepo(tempGitRepo);
          }
        },
        TEST_TIMEOUT
      );

      runTest(
        "refuses to remove an unregistered workspace and changes nothing",
        async () => {
          const env = await createTestEnvironment();

          try {
            // An id with no registered row cannot be proven to lie outside a protected sub-agent
            // task footprint (e.g. a cooperating backend's task whose session exists before its
            // row is published), so removal refuses instead of doing a phantom session cleanup.
            // Cover both a bare unknown id and one whose session directory already exists.
            const bareId = "non-existent-workspace-id";
            const withSessionId = "unregistered-with-session";
            const sessionDir = path.join(env.config.sessionsDir, withSessionId);
            const sentinel = path.join(sessionDir, "chat.jsonl");
            const sentinelBytes = '{"id":"sentinel","role":"user","parts":[]}\n';
            await fs.mkdir(sessionDir, { recursive: true });
            await fs.writeFile(sentinel, sentinelBytes);
            const configBefore = JSON.stringify([...env.config.loadConfigOrDefault().projects]);

            for (const workspaceId of [bareId, withSessionId]) {
              const deleteResult = await env.orpc.workspace.remove({ workspaceId });
              expect(deleteResult.success).toBe(false);
              if (!deleteResult.success) {
                expect(deleteResult.error).toContain(`"${workspaceId}"`);
                expect(deleteResult.error).toContain("not registered");
              }
            }

            expect(JSON.stringify([...env.config.loadConfigOrDefault().projects])).toBe(
              configBefore
            );
            expect(await fs.readFile(sentinel, "utf-8")).toBe(sentinelBytes);
            await expect(fs.access(path.join(env.config.sessionsDir, bareId))).rejects.toThrow();
          } finally {
            await cleanupTestEnvironment(env);
          }
        },
        TEST_TIMEOUT
      );

      runTest(
        "should handle deletion when directory is already deleted",
        async () => {
          const env = await createTestEnvironment();
          const tempGitRepo = await createTempGitRepo();

          try {
            const branchName = generateBranchName("already-deleted");
            const runtimeConfig = getRuntimeConfig(branchName);
            const { workspaceId, workspacePath: _workspacePath } = await createWorkspaceWithInit(
              env,
              tempGitRepo,
              branchName,
              runtimeConfig,
              true, // waitForInit
              type === "ssh"
            );

            // Manually delete the workspace directory using bash (works for both local and SSH)
            await executeBash(env, workspaceId, 'cd .. && rm -rf "$(basename "$PWD")"');

            // Verify it's gone (note: workspace is deleted, so we can't use executeBash on workspaceId anymore)
            // We'll verify via the delete operation and config check

            // Delete via ORPC - should succeed and prune stale metadata
            const deleteResult = await env.orpc.workspace.remove({ workspaceId });
            expect(deleteResult.success).toBe(true);

            // Verify workspace is no longer in config
            const config = env.config.loadConfigOrDefault();
            const project = config.projects.get(tempGitRepo);
            if (project) {
              const stillInConfig = project.workspaces.some((w) => w.id === workspaceId);
              expect(stillInConfig).toBe(false);
            }
          } finally {
            await cleanupTestEnvironment(env);
            await cleanupTempGitRepo(tempGitRepo);
          }
        },
        TEST_TIMEOUT
      );

      runTest(
        "should fail to delete dirty workspace without force flag",
        async () => {
          const env = await createTestEnvironment();
          const tempGitRepo = await createTempGitRepo();

          try {
            const branchName = generateBranchName("delete-dirty");
            const runtimeConfig = getRuntimeConfig(branchName);
            const { workspaceId } = await createWorkspaceWithInit(
              env,
              tempGitRepo,
              branchName,
              runtimeConfig,
              true, // waitForInit
              type === "ssh"
            );

            // Make workspace dirty by modifying a file through bash
            await makeWorkspaceDirty(env, workspaceId);

            // Attempt to delete without force should fail
            const deleteResult = await env.orpc.workspace.remove({ workspaceId });
            expect(deleteResult.success).toBe(false);
            expect(deleteResult.error).toMatch(
              /uncommitted changes|worktree contains modified|contains modified or untracked files/i
            );

            // Verify workspace still exists
            const stillExists = await workspaceExists(env, workspaceId);
            expect(stillExists).toBe(true);

            // Cleanup: force delete for cleanup
            await env.orpc.workspace.remove({ workspaceId, options: { force: true } });
          } finally {
            await cleanupTestEnvironment(env);
            await cleanupTempGitRepo(tempGitRepo);
          }
        },
        TEST_TIMEOUT
      );

      runTest(
        "should delete dirty workspace with force flag",
        async () => {
          const env = await createTestEnvironment();
          const tempGitRepo = await createTempGitRepo();

          try {
            const branchName = generateBranchName("delete-dirty-force");
            const runtimeConfig = getRuntimeConfig(branchName);
            const { workspaceId } = await createWorkspaceWithInit(
              env,
              tempGitRepo,
              branchName,
              runtimeConfig,
              true, // waitForInit
              type === "ssh"
            );

            // Make workspace dirty through bash
            await makeWorkspaceDirty(env, workspaceId);

            // Delete with force should succeed
            const deleteResult = await env.orpc.workspace.remove({
              workspaceId,
              options: { force: true },
            });
            expect(deleteResult.success).toBe(true);

            // Verify workspace is no longer in config
            const config = env.config.loadConfigOrDefault();
            const project = config.projects.get(tempGitRepo);
            if (project) {
              const stillInConfig = project.workspaces.some((w) => w.id === workspaceId);
              expect(stillInConfig).toBe(false);
            }
          } finally {
            await cleanupTestEnvironment(env);
            await cleanupTempGitRepo(tempGitRepo);
          }
        },
        TEST_TIMEOUT
      );

      // Submodule tests only apply to local runtime (SSH doesn't use git worktrees)
      if (type === "local") {
        runTest(
          "should successfully delete clean workspace with submodule",
          async () => {
            const env = await createTestEnvironment();
            const tempGitRepo = await createTempGitRepo();

            try {
              const branchName = generateBranchName("delete-submodule-clean");
              const { workspaceId, workspacePath } = await createWorkspaceWithInit(
                env,
                tempGitRepo,
                branchName,
                undefined,
                true, // waitForInit
                false // not SSH
              );

              await addSubmodule(workspacePath);

              // Verify submodule is initialized
              const submoduleExists = await fs
                .access(path.join(workspacePath, "vendor", "left-pad"))
                .then(() => true)
                .catch(() => false);
              expect(submoduleExists).toBe(true);

              // Worktree has submodule - need force flag to delete via rm -rf fallback
              const deleteResult = await env.orpc.workspace.remove({
                workspaceId,
                options: { force: true },
              });
              if (!deleteResult.success) {
                console.error("Delete with submodule failed:", deleteResult.error);
              }
              expect(deleteResult.success).toBe(true);

              // Verify workspace was deleted
              const removed = await waitForFileNotExists(workspacePath, 5000);
              expect(removed).toBe(true);
            } finally {
              await cleanupTestEnvironment(env);
              await cleanupTempGitRepo(tempGitRepo);
            }
          },
          30000
        );

        runTest(
          "should fail to delete dirty workspace with submodule, succeed with force",
          async () => {
            const env = await createTestEnvironment();
            const tempGitRepo = await createTempGitRepo();

            try {
              const branchName = generateBranchName("delete-submodule-dirty");
              const { workspaceId, workspacePath } = await createWorkspaceWithInit(
                env,
                tempGitRepo,
                branchName,
                undefined,
                true, // waitForInit
                false // not SSH
              );

              await addSubmodule(workspacePath);

              // Make worktree dirty
              await fs.appendFile(path.join(workspacePath, "README.md"), "\nmodified");

              // First attempt should fail (dirty worktree with submodules)
              const deleteResult = await env.orpc.workspace.remove({ workspaceId });
              expect(deleteResult.success).toBe(false);
              expect(deleteResult.error).toMatch(/submodule/i);

              // Verify worktree still exists
              const stillExists = await fs
                .access(workspacePath)
                .then(() => true)
                .catch(() => false);
              expect(stillExists).toBe(true);

              // Retry with force should succeed
              const forceDeleteResult = await env.orpc.workspace.remove({
                workspaceId,
                options: { force: true },
              });
              expect(forceDeleteResult.success).toBe(true);

              // Verify workspace was deleted
              const removed = await waitForFileNotExists(workspacePath, 5000);
              expect(removed).toBe(true);
            } finally {
              await cleanupTestEnvironment(env);
              await cleanupTempGitRepo(tempGitRepo);
            }
          },
          30000
        );
      }
    }
  );

  // Local project-dir runtime specific tests
  // These test the new LocalRuntime that uses project directory directly (no worktree isolation)
  describe("Local project-dir runtime tests", () => {
    const getLocalProjectDirConfig = (): RuntimeConfig => {
      // Local project-dir: type "local" without srcBaseDir
      return { type: "local" };
    };

    test.concurrent(
      "should delete only the specified workspace, not all workspaces with same path",
      async () => {
        const env = await createTestEnvironment();
        const tempGitRepo = await createTempGitRepo();

        try {
          const runtimeConfig = getLocalProjectDirConfig();

          // Create multiple local workspaces for the same project
          // All will have the same workspacePath (the project directory)
          const { workspaceId: ws1Id } = await createWorkspaceWithInit(
            env,
            tempGitRepo,
            "local-ws-1",
            runtimeConfig,
            true, // waitForInit
            false // not SSH
          );

          const { workspaceId: ws2Id } = await createWorkspaceWithInit(
            env,
            tempGitRepo,
            "local-ws-2",
            runtimeConfig,
            true,
            false
          );

          const { workspaceId: ws3Id } = await createWorkspaceWithInit(
            env,
            tempGitRepo,
            "local-ws-3",
            runtimeConfig,
            true,
            false
          );

          // Verify all three workspaces exist in config
          let config = env.config.loadConfigOrDefault();
          let project = config.projects.get(tempGitRepo);
          expect(project?.workspaces.length).toBe(3);
          expect(project?.workspaces.some((w) => w.id === ws1Id)).toBe(true);
          expect(project?.workspaces.some((w) => w.id === ws2Id)).toBe(true);
          expect(project?.workspaces.some((w) => w.id === ws3Id)).toBe(true);

          // Delete workspace 2
          const deleteResult = await env.orpc.workspace.remove({ workspaceId: ws2Id });
          expect(deleteResult.success).toBe(true);

          // Verify ONLY workspace 2 was removed, workspaces 1 and 3 still exist
          config = env.config.loadConfigOrDefault();
          project = config.projects.get(tempGitRepo);

          // BUG: Currently all 3 get deleted because they share the same workspacePath
          // After fix: Only ws2 should be deleted
          expect(project?.workspaces.length).toBe(2);
          expect(project?.workspaces.some((w) => w.id === ws1Id)).toBe(true);
          expect(project?.workspaces.some((w) => w.id === ws2Id)).toBe(false); // deleted
          expect(project?.workspaces.some((w) => w.id === ws3Id)).toBe(true);

          // Cleanup remaining workspaces
          await env.orpc.workspace.remove({ workspaceId: ws1Id });
          await env.orpc.workspace.remove({ workspaceId: ws3Id });
        } finally {
          await cleanupTestEnvironment(env);
          await cleanupTempGitRepo(tempGitRepo);
        }
      },
      TEST_TIMEOUT_LOCAL_MS
    );

    test.concurrent(
      "should not delete project directory when deleting local workspace",
      async () => {
        const env = await createTestEnvironment();
        const tempGitRepo = await createTempGitRepo();

        try {
          const runtimeConfig = getLocalProjectDirConfig();
          const { workspaceId } = await createWorkspaceWithInit(
            env,
            tempGitRepo,
            "local-ws-test",
            runtimeConfig,
            true,
            false
          );

          // Verify workspace exists
          const existsBefore = await workspaceExists(env, workspaceId);
          expect(existsBefore).toBe(true);

          // Delete workspace
          const deleteResult = await env.orpc.workspace.remove({ workspaceId });
          expect(deleteResult.success).toBe(true);

          // Project directory should still exist (LocalRuntime.deleteWorkspace is a no-op)
          const projectDirExists = await fs
            .access(tempGitRepo)
            .then(() => true)
            .catch(() => false);
          expect(projectDirExists).toBe(true);
        } finally {
          await cleanupTestEnvironment(env);
          await cleanupTempGitRepo(tempGitRepo);
        }
      },
      TEST_TIMEOUT_LOCAL_MS
    );
  });

  // SSH-specific tests (unpushed refs only matter for SSH, not local worktrees which share .git)
  describe("SSH-only tests", () => {
    // SSH-only tests run serially to avoid overloading the shared Docker container.
    const runSshTest = getTestRunner("ssh");
    const getRuntimeConfig = (_branchName: string): RuntimeConfig | undefined => {
      if (!sshConfig) {
        throw new Error("SSH config not initialized");
      }
      return {
        type: "ssh",
        host: `testuser@localhost`,
        srcBaseDir: sshConfig.workdir,
        identityFile: sshConfig.privateKeyPath,
        port: sshConfig.port,
      };
    };

    runSshTest(
      "should fail to delete SSH workspace with unpushed refs without force flag",
      async () => {
        const env = await createTestEnvironment();
        const tempGitRepo = await createTempGitRepo();

        try {
          const branchName = generateBranchName("delete-unpushed");
          const runtimeConfig = getRuntimeConfig(branchName);
          const { workspaceId } = await createWorkspaceWithInit(
            env,
            tempGitRepo,
            branchName,
            runtimeConfig,
            true, // waitForInit
            true // isSSH
          );

          // Configure git for committing (SSH environment needs this)
          await executeBash(env, workspaceId, 'git config user.email "test@example.com"');
          await executeBash(env, workspaceId, 'git config user.name "Test User"');

          // Set a fake remote (needed for unpushed check to work).
          // Use set-url||add since worktree-based workspaces inherit origin from the base repo.
          await executeBash(
            env,
            workspaceId,
            "git remote set-url origin https://github.com/fake/repo.git 2>/dev/null || git remote add origin https://github.com/fake/repo.git"
          );

          // Create a commit in the workspace (unpushed)
          await executeBash(env, workspaceId, 'echo "new content" > newfile.txt');
          await executeBash(env, workspaceId, "git add newfile.txt");
          await executeBash(env, workspaceId, 'git commit -m "Unpushed commit"');

          // Verify commit was created and working tree is clean
          const statusResult = await executeBash(env, workspaceId, "git status --porcelain");
          expect(statusResult.output.trim()).toBe(""); // Should be clean

          // Attempt to delete without force should fail
          const deleteResult = await env.orpc.workspace.remove({ workspaceId });
          expect(deleteResult.success).toBe(false);
          expect(deleteResult.error).toMatch(/unpushed.*commit|unpushed.*ref/i);

          // Verify workspace still exists
          const stillExists = await workspaceExists(env, workspaceId);
          expect(stillExists).toBe(true);

          // Cleanup: force delete for cleanup
          await env.orpc.workspace.remove({ workspaceId, options: { force: true } });
        } finally {
          await cleanupTestEnvironment(env);
          await cleanupTempGitRepo(tempGitRepo);
        }
      },
      TEST_TIMEOUT_SSH_MS
    );

    runSshTest(
      "should delete SSH workspace with unpushed refs when force flag is set",
      async () => {
        const env = await createTestEnvironment();
        const tempGitRepo = await createTempGitRepo();

        try {
          const branchName = generateBranchName("delete-unpushed-force");
          const runtimeConfig = getRuntimeConfig(branchName);
          const { workspaceId } = await createWorkspaceWithInit(
            env,
            tempGitRepo,
            branchName,
            runtimeConfig,
            true, // waitForInit
            true // isSSH
          );

          // Configure git for committing (SSH environment needs this)
          await executeBash(env, workspaceId, 'git config user.email "test@example.com"');
          await executeBash(env, workspaceId, 'git config user.name "Test User"');

          // Set a fake remote (needed for unpushed check to work).
          // Use set-url||add since worktree-based workspaces inherit origin from the base repo.
          await executeBash(
            env,
            workspaceId,
            "git remote set-url origin https://github.com/fake/repo.git 2>/dev/null || git remote add origin https://github.com/fake/repo.git"
          );

          // Create a commit in the workspace (unpushed)
          await executeBash(env, workspaceId, 'echo "new content" > newfile.txt');
          await executeBash(env, workspaceId, "git add newfile.txt");
          await executeBash(env, workspaceId, 'git commit -m "Unpushed commit"');

          // Verify commit was created and working tree is clean
          const statusResult = await executeBash(env, workspaceId, "git status --porcelain");
          expect(statusResult.output.trim()).toBe(""); // Should be clean

          // Delete with force should succeed
          const deleteResult = await env.orpc.workspace.remove({
            workspaceId,
            options: { force: true },
          });
          expect(deleteResult.success).toBe(true);

          // Verify workspace was removed from config
          const config = env.config.loadConfigOrDefault();
          const project = config.projects.get(tempGitRepo);
          if (project) {
            const stillInConfig = project.workspaces.some((w) => w.id === workspaceId);
            expect(stillInConfig).toBe(false);
          }
        } finally {
          await cleanupTestEnvironment(env);
          await cleanupTempGitRepo(tempGitRepo);
        }
      },
      TEST_TIMEOUT_SSH_MS
    );

    // TODO(#2279): deleteResult.success returns false in CI for worktree-based
    // SSH workspaces. The structurally-identical "unpushed refs" test at line 774
    // passes, suggesting a timing/state issue specific to serial test execution
    // in Docker. The non-SSH variant covers the same logic.
    runSshTest.skip(
      "should include commit list in error for unpushed refs",
      async () => {
        const env = await createTestEnvironment();
        const tempGitRepo = await createTempGitRepo();

        try {
          const branchName = generateBranchName("delete-unpushed-details");
          const runtimeConfig = getRuntimeConfig(branchName);
          const { workspaceId } = await createWorkspaceWithInit(
            env,
            tempGitRepo,
            branchName,
            runtimeConfig,
            true, // waitForInit
            true // isSSH
          );

          // Configure git for committing (SSH environment needs this)
          await executeBash(env, workspaceId, 'git config user.email "test@example.com"');
          await executeBash(env, workspaceId, 'git config user.name "Test User"');

          // Add a fake remote (needed for unpushed check to work).
          // Use set-url||add pattern since worktree-based workspaces inherit
          // an origin remote from the shared base repo.
          await executeBash(
            env,
            workspaceId,
            "git remote set-url origin https://github.com/fake/repo.git 2>/dev/null || git remote add origin https://github.com/fake/repo.git"
          );

          // Create multiple commits with descriptive messages
          await executeBash(env, workspaceId, 'echo "1" > file1.txt');
          await executeBash(env, workspaceId, "git add file1.txt");
          await executeBash(env, workspaceId, 'git commit -m "First commit"');

          await executeBash(env, workspaceId, 'echo "2" > file2.txt');
          await executeBash(env, workspaceId, "git add file2.txt");
          await executeBash(env, workspaceId, 'git commit -m "Second commit"');

          // Attempt to delete
          const deleteResult = await env.orpc.workspace.remove({ workspaceId });

          // Should fail with error containing commit details
          expect(deleteResult.success).toBe(false);
          expect(deleteResult.error).toContain("unpushed commits:");
          expect(deleteResult.error).toContain("First commit");
          expect(deleteResult.error).toContain("Second commit");

          // Cleanup: force delete for cleanup
          await env.orpc.workspace.remove({ workspaceId, options: { force: true } });
        } finally {
          await cleanupTestEnvironment(env);
          await cleanupTempGitRepo(tempGitRepo);
        }
      },
      TEST_TIMEOUT_SSH_MS
    );

    // TODO(#2279): Same root cause as "unpushed refs" skip above.
    runSshTest.skip(
      "should allow deletion of squash-merged branches without force flag",
      async () => {
        const env = await createTestEnvironment();
        const tempGitRepo = await createTempGitRepo();

        try {
          const branchName = generateBranchName("squash-merge-test");
          const runtimeConfig = getRuntimeConfig(branchName);
          const { workspaceId } = await createWorkspaceWithInit(
            env,
            tempGitRepo,
            branchName,
            runtimeConfig,
            true, // waitForInit
            true // isSSH
          );

          // Configure git for committing
          await executeBash(env, workspaceId, 'git config user.email "test@example.com"');
          await executeBash(env, workspaceId, 'git config user.name "Test User"');

          // Get the current workspace path (inside SSH container)
          const pwdResult = await executeBash(env, workspaceId, "pwd");
          const workspacePath = pwdResult.output.trim();

          // Create a bare repo inside the SSH container to act as "origin"
          // This avoids issues with host paths not being accessible in container
          const originPath = `${workspacePath}/../.test-origin-${branchName}`;
          await executeBash(env, workspaceId, `git clone --bare . "${originPath}"`);

          // Point origin to the bare repo (add if doesn't exist, set-url if it does)
          await executeBash(
            env,
            workspaceId,
            `git remote get-url origin >/dev/null 2>&1 && git remote set-url origin "${originPath}" || git remote add origin "${originPath}"`
          );

          // Create feature commits on the branch
          await executeBash(env, workspaceId, 'echo "feature1" > feature.txt');
          await executeBash(env, workspaceId, "git add feature.txt");
          await executeBash(env, workspaceId, 'git commit -m "Feature commit 1"');

          await executeBash(env, workspaceId, 'echo "feature2" >> feature.txt');
          await executeBash(env, workspaceId, "git add feature.txt");
          await executeBash(env, workspaceId, 'git commit -m "Feature commit 2"');

          // Get the feature branch's final file content
          const featureContent = await executeBash(env, workspaceId, "cat feature.txt");

          // Simulate squash-merge: create a temp worktree, add the squash commit to main, push
          // We need to work around bare repo limitations by using a temp checkout
          const tempCheckoutPath = `${workspacePath}/../.test-temp-checkout-${branchName}`;
          await executeBash(
            env,
            workspaceId,
            `git clone "${originPath}" "${tempCheckoutPath}" && ` +
              `cd "${tempCheckoutPath}" && ` +
              `git config user.email "test@example.com" && ` +
              `git config user.name "Test User" && ` +
              // Checkout main (or master, depending on git version)
              `(git checkout main 2>/dev/null || git checkout master) && ` +
              // Create squash commit with same content (use printf '%s\n' to match echo's newline)
              `printf '%s\\n' '${featureContent.output.trim().replace(/'/g, "'\\''")}' > feature.txt && ` +
              `git add feature.txt && ` +
              `git commit -m "Squash: Feature commits" && ` +
              `git push origin HEAD`
          );

          // Cleanup temp checkout
          await executeBash(env, workspaceId, `rm -rf "${tempCheckoutPath}"`);

          // Fetch the updated origin in the workspace
          await executeBash(env, workspaceId, "git fetch origin");

          // Verify we have unpushed commits (branch commits are not ancestors of origin/main)
          const logResult = await executeBash(
            env,
            workspaceId,
            "git log --branches --not --remotes --oneline"
          );
          // Should show commits since our branch commits != squash commit SHA
          expect(logResult.output.trim()).not.toBe("");

          // Now attempt deletion without force - should succeed because content matches
          const deleteResult = await env.orpc.workspace.remove({ workspaceId });

          // Should succeed - squash-merge detection should recognize content is in main
          expect(deleteResult.success).toBe(true);

          // Cleanup the bare repo we created
          // Note: This runs after workspace is deleted, may fail if path is gone
          try {
            using cleanupProc = execAsync(`rm -rf "${originPath}"`);
            await cleanupProc.result;
          } catch {
            // Ignore cleanup errors
          }

          // Verify workspace was removed from config
          const config = env.config.loadConfigOrDefault();
          const project = config.projects.get(tempGitRepo);
          if (project) {
            const stillInConfig = project.workspaces.some((w) => w.id === workspaceId);
            expect(stillInConfig).toBe(false);
          }
        } finally {
          await cleanupTestEnvironment(env);
          await cleanupTempGitRepo(tempGitRepo);
        }
      },
      TEST_TIMEOUT_SSH_MS
    );

    runSshTest(
      "should block deletion when branch has genuinely unmerged content",
      async () => {
        const env = await createTestEnvironment();
        const tempGitRepo = await createTempGitRepo();

        try {
          const branchName = generateBranchName("unmerged-content-test");
          const runtimeConfig = getRuntimeConfig(branchName);
          const { workspaceId } = await createWorkspaceWithInit(
            env,
            tempGitRepo,
            branchName,
            runtimeConfig,
            true, // waitForInit
            true // isSSH
          );

          // Configure git for committing
          await executeBash(env, workspaceId, 'git config user.email "test@example.com"');
          await executeBash(env, workspaceId, 'git config user.name "Test User"');

          // Get the current workspace path (inside SSH container)
          const pwdResult = await executeBash(env, workspaceId, "pwd");
          const workspacePath = pwdResult.output.trim();

          // Create a bare repo inside the SSH container to act as "origin"
          const originPath = `${workspacePath}/../.test-origin-${branchName}`;
          await executeBash(env, workspaceId, `git clone --bare . "${originPath}"`);

          // Point origin to the bare repo (add if doesn't exist, set-url if it does)
          await executeBash(
            env,
            workspaceId,
            `git remote get-url origin >/dev/null 2>&1 && git remote set-url origin "${originPath}" || git remote add origin "${originPath}"`
          );

          // Create feature commits with unique content (not in origin)
          await executeBash(env, workspaceId, 'echo "unique-unmerged-content" > unique.txt');
          await executeBash(env, workspaceId, "git add unique.txt");
          await executeBash(env, workspaceId, 'git commit -m "Unique commit"');

          // Fetch origin (main doesn't have our content - we didn't push)
          await executeBash(env, workspaceId, "git fetch origin");

          // Attempt deletion without force - should fail because content differs
          const deleteResult = await env.orpc.workspace.remove({ workspaceId });

          // Should fail - genuinely unmerged content
          expect(deleteResult.success).toBe(false);
          expect(deleteResult.error).toMatch(/unpushed|changes/i);

          // Verify workspace still exists
          const stillExists = await workspaceExists(env, workspaceId);
          expect(stillExists).toBe(true);

          // Cleanup: force delete
          await env.orpc.workspace.remove({ workspaceId, options: { force: true } });

          // Cleanup the bare repo
          try {
            using cleanupProc = execAsync(`rm -rf "${originPath}"`);
            await cleanupProc.result;
          } catch {
            // Ignore cleanup errors
          }
        } finally {
          await cleanupTestEnvironment(env);
          await cleanupTempGitRepo(tempGitRepo);
        }
      },
      TEST_TIMEOUT_SSH_MS
    );
  });
});
