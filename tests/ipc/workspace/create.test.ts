/**
 * Integration tests for WORKSPACE_CREATE IPC handler
 *
 * Tests both LocalRuntime and SSHRuntime without mocking to verify:
 * - Workspace creation mechanics (git worktree, directory structure)
 * - Branch handling (new vs existing branches)
 * - Init hook execution with logging
 * - Parity between runtime implementations
 *
 * Uses real IPC handlers, real git operations, and Docker SSH server.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { shouldRunIntegrationTests, createTestEnvironment, cleanupTestEnvironment } from "../setup";
import type { TestEnvironment } from "../setup";
import {
  createTempGitRepo,
  cleanupTempGitRepo,
  generateBranchName,
  createStreamCollector,
  getTestRunner,
} from "../helpers";
import type { OrpcTestClient } from "../orpcTestClient";
import { detectDefaultTrunkBranch } from "../../../src/node/git";
import {
  isDockerAvailable,
  startSSHServer,
  stopSSHServer,
  type SSHServerConfig,
} from "../../runtime/test-fixtures/ssh-fixture";
import type { RuntimeConfig } from "../../../src/common/types/runtime";
import { getSrcBaseDir } from "../../../src/common/types/runtime";
import type { FrontendWorkspaceMetadata } from "../../../src/common/types/workspace";
import { createRuntime } from "../../../src/node/runtime/runtimeFactory";
import type { SSHRuntime } from "../../../src/node/runtime/SSHRuntime";
import { streamToString } from "../../../src/node/runtime/streamUtils";
import { sshConnectionPool } from "../../../src/node/runtime/sshConnectionPool";
import { ssh2ConnectionPool } from "../../../src/node/runtime/SSH2ConnectionPool";

const execAsync = promisify(exec);

// Test constants
const TEST_TIMEOUT_MS = 60000;
type ExecuteBashResult = Awaited<ReturnType<OrpcTestClient["workspace"]["executeBash"]>>;

function expectExecuteBashSuccess(result: ExecuteBashResult, context: string) {
  expect(result.success).toBe(true);
  if (!result.success || !result.data) {
    const errorMessage = "error" in result ? result.error : "unknown error";
    throw new Error(`workspace.executeBash failed (${context}): ${errorMessage}`);
  }
  return result.data;
}
const INIT_HOOK_WAIT_MS = 1500; // Wait for async init hook completion (local runtime)
const SSH_INIT_WAIT_MS = 7000; // SSH init includes sync + checkout + hook, takes longer
const MUX_DIR = ".mux";
const INIT_HOOK_FILENAME = "init";

// Event type constants
const EVENT_TYPE_INIT_OUTPUT = "init-output";
const EVENT_TYPE_INIT_END = "init-end";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// SSH server config (shared across all SSH tests)
let sshConfig: SSHServerConfig | undefined;

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Filter events by type.
 * Works with WorkspaceChatMessage events from StreamCollector.
 */
function filterEventsByType<T>(events: T[], eventType: string): T[] {
  return events.filter((e) => {
    if (e && typeof e === "object" && "type" in e) {
      return (e as { type: string }).type === eventType;
    }
    return false;
  });
}

/**
 * Set up init event capture using StreamCollector.
 * Init events are captured via ORPC subscription.
 */
async function setupInitEventCapture(env: TestEnvironment, workspaceId: string) {
  const collector = createStreamCollector(env.orpc, workspaceId);
  collector.start();
  return collector;
}

/**
 * Create init hook file in git repo
 */
async function createInitHook(repoPath: string, hookContent: string): Promise<void> {
  const muxDir = path.join(repoPath, MUX_DIR);
  await fs.mkdir(muxDir, { recursive: true });
  const initHookPath = path.join(muxDir, INIT_HOOK_FILENAME);
  await fs.writeFile(initHookPath, hookContent, { mode: 0o755 });
}

/**
 * Commit changes in git repo
 */
async function commitChanges(repoPath: string, message: string): Promise<void> {
  await execAsync(`git add -A && git commit -m "${message}"`, {
    cwd: repoPath,
  });
}

/**
 * Create workspace and handle cleanup on test failure
 * Returns result and cleanup function
 */
async function createWorkspaceWithCleanup(
  env: TestEnvironment,
  projectPath: string,
  branchName: string,
  trunkBranch: string,
  runtimeConfig?: RuntimeConfig
): Promise<{
  result:
    | { success: true; metadata: FrontendWorkspaceMetadata }
    | { success: false; error: string };
  cleanup: () => Promise<void>;
}> {
  // Trust the project so hooks and scripts can run during workspace creation
  await env.orpc.projects.setTrust({ projectPath, trusted: true });

  const result = await env.orpc.workspace.create({
    projectPath,
    branchName,
    trunkBranch,
    runtimeConfig,
  });
  console.log("Create invoked, success:", result.success);

  // Note: Events are forwarded via test setup wiring in setup.ts:
  // workspaceService.on("chat") -> windowService.send() -> webContents.send()
  // No need for additional ORPC subscription pipe here.

  const cleanup = async () => {
    if (result.success) {
      await env.orpc.workspace.remove({ workspaceId: result.metadata.id });
    }
  };

  return { result, cleanup };
}

describeIntegration("WORKSPACE_CREATE with both runtimes", () => {
  beforeAll(async () => {
    // Check if Docker is available (required for SSH tests)
    if (!(await isDockerAvailable())) {
      throw new Error(
        "Docker is required for SSH runtime tests. Please install Docker or skip tests by unsetting TEST_INTEGRATION."
      );
    }

    // Start SSH server (shared across all tests for speed)
    console.log("Starting SSH server container for createWorkspace tests...");
    sshConfig = await startSSHServer();
    console.log(`SSH server ready on port ${sshConfig.port}`);
  }, 60000); // 60s timeout for Docker operations

  afterAll(async () => {
    if (sshConfig) {
      console.log("Stopping SSH server container...");
      await stopSSHServer(sshConfig);
    }
  }, 30000);

  // Reset SSH connection pool state before each test to prevent backoff from one
  // test affecting subsequent tests. This allows tests to run concurrently.
  beforeEach(() => {
    sshConnectionPool.clearAllHealthForTests();
    ssh2ConnectionPool.clearAllHealthForTests();
  });

  // Test matrix: Run tests for both local and SSH runtimes
  describe.each<{ type: "local" | "ssh" }>([{ type: "local" }, { type: "ssh" }])(
    "Runtime: $type",
    ({ type }) => {
      // Helper to build runtime config
      const getRuntimeConfig = (_branchName: string): RuntimeConfig | undefined => {
        if (type === "ssh" && sshConfig) {
          return {
            type: "ssh",
            host: `testuser@localhost`,
            srcBaseDir: sshConfig.workdir,
            identityFile: sshConfig.privateKeyPath,
            port: sshConfig.port,
          };
        }
        return undefined; // undefined = defaults to local
      };

      // Get runtime-specific init wait time (SSH needs more time for rsync)
      const getInitWaitTime = () => (type === "ssh" ? SSH_INIT_WAIT_MS : INIT_HOOK_WAIT_MS);

      // SSH tests run serially to avoid Docker container overload
      const runTest = getTestRunner(type);

      describe("Branch handling", () => {
        runTest(
          "creates new branch from trunk when branch doesn't exist",
          async () => {
            const env = await createTestEnvironment();
            const tempGitRepo = await createTempGitRepo();

            try {
              const branchName = generateBranchName("new-branch");
              const trunkBranch = await detectDefaultTrunkBranch(tempGitRepo);
              const runtimeConfig = getRuntimeConfig(branchName);

              const { result, cleanup } = await createWorkspaceWithCleanup(
                env,
                tempGitRepo,
                branchName,
                trunkBranch,
                runtimeConfig
              );

              expect(result.success).toBe(true);
              if (!result.success) {
                throw new Error(
                  `Failed to create workspace for new branch '${branchName}': ${result.error}`
                );
              }

              // Verify workspace metadata
              expect(result.metadata.id).toBeDefined();
              expect(result.metadata.namedWorkspacePath).toBeDefined();
              expect(result.metadata.projectName).toBeDefined();

              await cleanup();
            } finally {
              await cleanupTestEnvironment(env);
              await cleanupTempGitRepo(tempGitRepo);
            }
          },
          TEST_TIMEOUT_MS
        );

        runTest(
          "checks out existing branch when branch already exists",
          async () => {
            const env = await createTestEnvironment();
            const tempGitRepo = await createTempGitRepo();

            try {
              // Use existing "test-branch" created by createTempGitRepo
              const branchName = "test-branch";
              const trunkBranch = await detectDefaultTrunkBranch(tempGitRepo);
              const runtimeConfig = getRuntimeConfig(branchName);

              const { result, cleanup } = await createWorkspaceWithCleanup(
                env,
                tempGitRepo,
                branchName,
                trunkBranch,
                runtimeConfig
              );

              expect(result.success).toBe(true);
              if (!result.success) {
                throw new Error(
                  `Failed to check out existing branch '${branchName}': ${result.error}`
                );
              }

              expect(result.metadata.id).toBeDefined();

              await cleanup();
            } finally {
              await cleanupTestEnvironment(env);
              await cleanupTempGitRepo(tempGitRepo);
            }
          },
          TEST_TIMEOUT_MS
        );

        runTest(
          "creates new branch from specified trunk branch, not from default branch",
          async () => {
            const env = await createTestEnvironment();
            const tempGitRepo = await createTempGitRepo();

            try {
              // Create a custom trunk branch with a unique commit
              const customTrunkBranch = "custom-trunk";
              await execAsync(
                `git checkout -b ${customTrunkBranch} && echo "custom-trunk-content" > trunk-file.txt && git add . && git commit -m "Custom trunk commit"`,
                { cwd: tempGitRepo }
              );

              // Create a different branch (which will become the default if we checkout to it)
              const otherBranch = "other-branch";
              await execAsync(
                `git checkout -b ${otherBranch} && echo "other-content" > other-file.txt && git add . && git commit -m "Other branch commit"`,
                { cwd: tempGitRepo }
              );

              // Switch back to the original default branch
              const defaultBranch = await detectDefaultTrunkBranch(tempGitRepo);
              await execAsync(`git checkout ${defaultBranch}`, { cwd: tempGitRepo });

              // Now create a workspace specifying custom-trunk as the trunk branch
              const newBranchName = generateBranchName("from-custom-trunk");
              const runtimeConfig = getRuntimeConfig(newBranchName);

              const { result, cleanup } = await createWorkspaceWithCleanup(
                env,
                tempGitRepo,
                newBranchName,
                customTrunkBranch, // Specify custom trunk branch
                runtimeConfig
              );

              expect(result.success).toBe(true);
              if (!result.success) {
                throw new Error(
                  `Failed to create workspace from custom trunk '${customTrunkBranch}': ${result.error}`
                );
              }

              // Wait for workspace initialization to complete
              await new Promise((resolve) => setTimeout(resolve, getInitWaitTime()));

              // Verify the new branch was created from custom-trunk, not from default branch
              // Use WORKSPACE_EXECUTE_BASH to check files (works for both local and SSH runtimes)

              // Check that trunk-file.txt exists (from custom-trunk)
              const checkTrunkFileResult = await env.orpc.workspace.executeBash({
                workspaceId: result.metadata.id,
                script: `test -f trunk-file.txt && echo "exists" || echo "missing"`,
              });
              const trunkFileData = expectExecuteBashSuccess(
                checkTrunkFileResult,
                "custom trunk: trunk-file"
              );
              expect((trunkFileData.output ?? "").trim()).toBe("exists");

              // Check that other-file.txt does NOT exist (from other-branch)
              const checkOtherFileResult = await env.orpc.workspace.executeBash({
                workspaceId: result.metadata.id,
                script: `test -f other-file.txt && echo "exists" || echo "missing"`,
              });
              const otherFileData = expectExecuteBashSuccess(
                checkOtherFileResult,
                "custom trunk: other-file"
              );
              expect((otherFileData.output ?? "").trim()).toBe("missing");

              // Verify git log shows the custom trunk commit
              const gitLogResult = await env.orpc.workspace.executeBash({
                workspaceId: result.metadata.id,
                script: `git log --oneline --all`,
              });
              const gitLogData = expectExecuteBashSuccess(gitLogResult, "custom trunk: git log");
              expect(gitLogData.output).toContain("Custom trunk commit");

              await cleanup();
            } finally {
              await cleanupTestEnvironment(env);
              await cleanupTempGitRepo(tempGitRepo);
            }
          },
          TEST_TIMEOUT_MS
        );
      });

      describe("Init hook execution", () => {
        runTest(
          "executes .mux/init hook when present and streams logs",
          async () => {
            const env = await createTestEnvironment();
            const tempGitRepo = await createTempGitRepo();

            try {
              // Create and commit init hook
              await createInitHook(
                tempGitRepo,
                `#!/bin/bash
echo "Init hook started"
echo "Installing dependencies..."
sleep 0.1
echo "Build complete" >&2
exit 0
`
              );
              await commitChanges(tempGitRepo, "Add init hook");

              const branchName = generateBranchName("hook-test");
              const trunkBranch = await detectDefaultTrunkBranch(tempGitRepo);
              const runtimeConfig = getRuntimeConfig(branchName);

              const { result, cleanup } = await createWorkspaceWithCleanup(
                env,
                tempGitRepo,
                branchName,
                trunkBranch,
                runtimeConfig
              );

              expect(result.success).toBe(true);
              if (!result.success) {
                throw new Error(`Failed to create workspace with init hook: ${result.error}`);
              }

              // Capture init events - subscription starts after workspace created
              // Init hook runs async, so events still streaming
              const workspaceId = result.metadata.id;
              const collector = await setupInitEventCapture(env, workspaceId);
              try {
                // Wait for init hook to complete
                await collector.waitForEvent("init-end", getInitWaitTime());

                const initEvents = collector.getEvents();

                // Verify init events were emitted
                expect(initEvents.length).toBeGreaterThan(0);

                // Verify output events (stdout/stderr from hook)
                const outputEvents = filterEventsByType(initEvents, EVENT_TYPE_INIT_OUTPUT);
                expect(outputEvents.length).toBeGreaterThan(0);

                // Verify completion event
                const endEvents = filterEventsByType(initEvents, EVENT_TYPE_INIT_END);
                expect(endEvents.length).toBe(1);
              } finally {
                collector.stop();
              }

              await cleanup();
            } finally {
              await cleanupTestEnvironment(env);
              await cleanupTempGitRepo(tempGitRepo);
            }
          },
          TEST_TIMEOUT_MS
        );

        runTest(
          "handles init hook failure gracefully",
          async () => {
            const env = await createTestEnvironment();
            const tempGitRepo = await createTempGitRepo();

            try {
              // Create and commit failing init hook
              await createInitHook(
                tempGitRepo,
                `#!/bin/bash
echo "Starting init..."
echo "Error occurred!" >&2
exit 1
`
              );
              await commitChanges(tempGitRepo, "Add failing hook");

              const branchName = generateBranchName("fail-hook");
              const trunkBranch = await detectDefaultTrunkBranch(tempGitRepo);
              const runtimeConfig = getRuntimeConfig(branchName);

              const { result, cleanup } = await createWorkspaceWithCleanup(
                env,
                tempGitRepo,
                branchName,
                trunkBranch,
                runtimeConfig
              );

              // Workspace creation should succeed even if hook fails
              expect(result.success).toBe(true);
              if (!result.success) {
                throw new Error(`Failed to create workspace with failing hook: ${result.error}`);
              }

              // Capture init events - subscription starts after workspace created
              const workspaceId = result.metadata.id;
              const collector = await setupInitEventCapture(env, workspaceId);
              try {
                // Wait for init hook to complete
                await collector.waitForEvent("init-end", getInitWaitTime());

                const initEvents = collector.getEvents();

                // Verify init-end event with non-zero exit code
                const endEvents = filterEventsByType(initEvents, EVENT_TYPE_INIT_END);
                expect(endEvents.length).toBe(1);

                const endEventData = endEvents[0] as { type: string; exitCode: number };
                expect(endEventData.exitCode).not.toBe(0);
                // Exit code can be 1 (script failure) or 127 (command not found on some systems)
              } finally {
                collector.stop();
              }

              await cleanup();
            } finally {
              await cleanupTestEnvironment(env);
              await cleanupTempGitRepo(tempGitRepo);
            }
          },
          TEST_TIMEOUT_MS
        );

        runTest(
          "completes successfully when no init hook present",
          async () => {
            const env = await createTestEnvironment();
            const tempGitRepo = await createTempGitRepo();

            try {
              const branchName = generateBranchName("no-hook");
              const trunkBranch = await detectDefaultTrunkBranch(tempGitRepo);
              const runtimeConfig = getRuntimeConfig(branchName);

              const { result, cleanup } = await createWorkspaceWithCleanup(
                env,
                tempGitRepo,
                branchName,
                trunkBranch,
                runtimeConfig
              );

              expect(result.success).toBe(true);
              if (!result.success) {
                throw new Error(`Failed to create workspace without init hook: ${result.error}`);
              }

              expect(result.metadata.id).toBeDefined();

              await cleanup();
            } finally {
              await cleanupTestEnvironment(env);
              await cleanupTempGitRepo(tempGitRepo);
            }
          },
          TEST_TIMEOUT_MS
        );

        // SSH-specific test: verify sync output appears in init stream
        if (type === "ssh") {
          runTest(
            "streams sync progress to init events (SSH only)",
            async () => {
              const env = await createTestEnvironment();
              const tempGitRepo = await createTempGitRepo();

              try {
                const branchName = generateBranchName("sync-test");
                const trunkBranch = await detectDefaultTrunkBranch(tempGitRepo);
                const runtimeConfig = getRuntimeConfig(branchName);

                const { result, cleanup } = await createWorkspaceWithCleanup(
                  env,
                  tempGitRepo,
                  branchName,
                  trunkBranch,
                  runtimeConfig
                );

                expect(result.success).toBe(true);
                if (!result.success) {
                  throw new Error(`Failed to create workspace for sync test: ${result.error}`);
                }

                // Capture init events - subscription starts after workspace created
                const workspaceId = result.metadata.id;
                const collector = await setupInitEventCapture(env, workspaceId);
                try {
                  // Wait for init to complete (includes sync + checkout)
                  await collector.waitForEvent("init-end", getInitWaitTime());

                  const allEvents = collector.getEvents();

                  // Verify init events contain sync and checkout steps
                  const outputEvents = filterEventsByType(allEvents, EVENT_TYPE_INIT_OUTPUT);
                  const outputLines = outputEvents.map((e) => {
                    const data = e as { line?: string; isError?: boolean };
                    return data.line ?? "";
                  });

                  // Debug: Print all output including errors
                  console.log("=== ALL INIT OUTPUT ===");
                  outputEvents.forEach((e) => {
                    const data = e as { line?: string; isError?: boolean };
                    const prefix = data.isError ? "[ERROR]" : "[INFO] ";
                    console.log(prefix + (data.line ?? ""));
                  });
                  console.log("=== END INIT OUTPUT ===");

                  // Verify key init phases appear in output
                  expect(outputLines.some((line) => line.includes("Syncing project files"))).toBe(
                    true
                  );
                  // SSH init creates a worktree (or checks out a branch on legacy workspaces)
                  expect(
                    outputLines.some(
                      (line) =>
                        line.includes("Checking out branch") ||
                        line.includes("Creating worktree for branch")
                    )
                  ).toBe(true);

                  // Verify init-end event was emitted
                  const endEvents = filterEventsByType(allEvents, EVENT_TYPE_INIT_END);
                  expect(endEvents.length).toBe(1);
                } finally {
                  collector.stop();
                }

                await cleanup();
              } finally {
                await cleanupTestEnvironment(env);
                await cleanupTempGitRepo(tempGitRepo);
              }
            },
            TEST_TIMEOUT_MS
          );

          runTest(
            "resolves tilde paths in srcBaseDir to absolute paths (SSH only)",
            async () => {
              if (!sshConfig) {
                throw new Error("SSH server is required for SSH integration tests");
              }

              const env = await createTestEnvironment();
              const tempGitRepo = await createTempGitRepo();

              try {
                const branchName = generateBranchName("tilde-resolution-test");
                const trunkBranch = await detectDefaultTrunkBranch(tempGitRepo);

                // Use tilde path - should be accepted and resolved
                const tildeRuntimeConfig: RuntimeConfig = {
                  type: "ssh",
                  host: `testuser@localhost`,
                  srcBaseDir: `~/workspace`,
                  identityFile: sshConfig.privateKeyPath,
                  port: sshConfig.port,
                };

                const { result, cleanup } = await createWorkspaceWithCleanup(
                  env,
                  tempGitRepo,
                  branchName,
                  trunkBranch,
                  tildeRuntimeConfig
                );

                // Should succeed and resolve tilde to absolute path
                expect(result.success).toBe(true);
                if (!result.success) {
                  throw new Error(`Failed to create workspace: ${result.error}`);
                }

                // Verify the stored runtimeConfig has resolved path (not tilde)
                const projectsConfig = env.config.loadConfigOrDefault();
                const projectWorkspaces =
                  projectsConfig.projects.get(tempGitRepo)?.workspaces ?? [];
                const workspace = projectWorkspaces.find((w) => w.name === branchName);

                expect(workspace).toBeDefined();
                const srcBaseDir = getSrcBaseDir(workspace?.runtimeConfig);
                expect(srcBaseDir).toBeDefined();
                expect(srcBaseDir).toMatch(/^\/home\//);
                expect(srcBaseDir).not.toContain("~");

                await cleanup();
              } finally {
                await cleanupTestEnvironment(env);
                await cleanupTempGitRepo(tempGitRepo);
              }
            },
            TEST_TIMEOUT_MS
          );

          runTest(
            "resolves bare tilde in srcBaseDir to home directory (SSH only)",
            async () => {
              if (!sshConfig) {
                throw new Error("SSH server is required for SSH integration tests");
              }

              const env = await createTestEnvironment();
              const tempGitRepo = await createTempGitRepo();

              try {
                const branchName = generateBranchName("bare-tilde-resolution");
                const trunkBranch = await detectDefaultTrunkBranch(tempGitRepo);

                // Use bare tilde - should be accepted and resolved to home directory
                const tildeRuntimeConfig: RuntimeConfig = {
                  type: "ssh",
                  host: `testuser@localhost`,
                  srcBaseDir: `~`,
                  identityFile: sshConfig.privateKeyPath,
                  port: sshConfig.port,
                };

                const { result, cleanup } = await createWorkspaceWithCleanup(
                  env,
                  tempGitRepo,
                  branchName,
                  trunkBranch,
                  tildeRuntimeConfig
                );

                // Should succeed and resolve tilde to home directory
                expect(result.success).toBe(true);
                if (!result.success) {
                  throw new Error(`Failed to create workspace: ${result.error}`);
                }

                // Verify the stored runtimeConfig has resolved path (not tilde)
                const projectsConfig = env.config.loadConfigOrDefault();
                const projectWorkspaces =
                  projectsConfig.projects.get(tempGitRepo)?.workspaces ?? [];
                const workspace = projectWorkspaces.find((w) => w.name === branchName);

                expect(workspace).toBeDefined();
                const srcBaseDir = getSrcBaseDir(workspace?.runtimeConfig);
                expect(srcBaseDir).toBeDefined();
                expect(srcBaseDir).toMatch(/^\/home\//);
                expect(srcBaseDir).not.toContain("~");

                await cleanup();
              } finally {
                await cleanupTestEnvironment(env);
                await cleanupTempGitRepo(tempGitRepo);
              }
            },
            TEST_TIMEOUT_MS
          );

          runTest(
            "can execute commands in workspace immediately after creation (SSH only)",
            async () => {
              const env = await createTestEnvironment();
              const tempGitRepo = await createTempGitRepo();

              try {
                const branchName = generateBranchName("exec-test");
                const trunkBranch = await detectDefaultTrunkBranch(tempGitRepo);
                const runtimeConfig = getRuntimeConfig(branchName);

                const { result, cleanup } = await createWorkspaceWithCleanup(
                  env,
                  tempGitRepo,
                  branchName,
                  trunkBranch,
                  runtimeConfig
                );

                expect(result.success).toBe(true);
                if (!result.success) {
                  throw new Error(`Failed to create workspace: ${result.error}`);
                }

                // Wait for init to complete
                await new Promise((resolve) => setTimeout(resolve, getInitWaitTime()));

                // Try to execute a command in the workspace
                const workspaceId = result.metadata.id;
                const execResult = await env.orpc.workspace.executeBash({
                  workspaceId,
                  script: "pwd",
                });

                const execData = expectExecuteBashSuccess(execResult, "SSH immediate command");

                // Verify we got output from the command
                expect(execData.output).toBeDefined();
                expect(execData.output?.trim().length ?? 0).toBeGreaterThan(0);

                await cleanup();
              } finally {
                await cleanupTestEnvironment(env);
                await cleanupTempGitRepo(tempGitRepo);
              }
            },
            TEST_TIMEOUT_MS
          );
        }
      });

      describe("Validation", () => {
        runTest(
          "rejects invalid workspace names",
          async () => {
            const env = await createTestEnvironment();
            const tempGitRepo = await createTempGitRepo();

            try {
              const invalidCases = [
                { name: "", expectedErrorFragment: "empty" },
                { name: "My-Branch", expectedErrorFragment: "lowercase" },
                { name: "branch name", expectedErrorFragment: "lowercase" },
                { name: "branch@123", expectedErrorFragment: "lowercase" },
                { name: "a".repeat(65), expectedErrorFragment: "64 characters" },
              ];

              const trunkBranch = await detectDefaultTrunkBranch(tempGitRepo);

              for (const { name, expectedErrorFragment } of invalidCases) {
                const runtimeConfig = getRuntimeConfig(name);
                const { result } = await createWorkspaceWithCleanup(
                  env,
                  tempGitRepo,
                  name,
                  trunkBranch,
                  runtimeConfig
                );

                expect(result.success).toBe(false);

                if (!result.success) {
                  expect(result.error.toLowerCase()).toContain(expectedErrorFragment.toLowerCase());
                }
              }
            } finally {
              await cleanupTestEnvironment(env);
              await cleanupTempGitRepo(tempGitRepo);
            }
          },
          TEST_TIMEOUT_MS
        );
      });
    }
  );

  // SSH-specific tests (outside matrix)
  describe("SSH-specific behavior", () => {
    test.concurrent(
      "forwards origin remote instead of bundle path",
      async () => {
        if (!sshConfig) {
          throw new Error("SSH server is required for SSH integration tests");
        }

        const env = await createTestEnvironment();
        const tempGitRepo = await createTempGitRepo();

        try {
          // Set up a real origin remote in the test repo
          // Use example.com to avoid global git config rewrites (e.g. insteadOf https://github.com/)
          const originUrl = "https://example.com/example/test-repo.git";
          await execAsync(`git remote add origin ${originUrl}`, {
            cwd: tempGitRepo,
          });

          // Verify origin was added
          const { stdout: originCheck } = await execAsync(`git remote get-url origin`, {
            cwd: tempGitRepo,
          });
          expect(originCheck.trim()).toBe(originUrl);

          const branchName = generateBranchName();
          const trunkBranch = await detectDefaultTrunkBranch(tempGitRepo);

          const runtimeConfig: RuntimeConfig = {
            type: "ssh",
            host: "testuser@localhost",
            srcBaseDir: sshConfig.workdir,
            identityFile: sshConfig.privateKeyPath,
            port: sshConfig.port,
          };

          const { result, cleanup } = await createWorkspaceWithCleanup(
            env,
            tempGitRepo,
            branchName,
            trunkBranch,
            runtimeConfig
          );

          try {
            expect(result.success).toBe(true);
            if (!result.success) return;

            // Wait for init to complete
            await new Promise((resolve) => setTimeout(resolve, SSH_INIT_WAIT_MS));

            // Create runtime to check remote on SSH host
            const runtime = createRuntime(runtimeConfig);
            const workspacePath = runtime.getWorkspacePath(tempGitRepo, branchName);

            // Check that origin remote exists and points to the original URL, not the bundle
            const checkOriginCmd = `git -C ${workspacePath} remote get-url origin`;
            const originStream = await (runtime as SSHRuntime).exec(checkOriginCmd, {
              cwd: "~",
              timeout: 10,
            });

            const [stdout, _stderr, exitCode] = await Promise.all([
              streamToString(originStream.stdout),
              streamToString(originStream.stderr),
              originStream.exitCode,
            ]);

            expect(exitCode).toBe(0);
            const remoteUrl = stdout.trim();

            // Should be the original origin URL, not the bundle path
            expect(remoteUrl).toBe(originUrl);
            expect(remoteUrl).not.toContain(".bundle");
            expect(remoteUrl).not.toContain(".mux-bundle");
          } finally {
            await cleanup();
          }
        } finally {
          await cleanupTestEnvironment(env);
          await cleanupTempGitRepo(tempGitRepo);
        }
      },
      TEST_TIMEOUT_MS
    );
  });
});
