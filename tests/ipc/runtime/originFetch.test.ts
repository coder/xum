/**
 * Integration tests for origin fetch ordering during workspace creation.
 *
 * Verifies that WorktreeRuntime and SSHRuntime fetch from origin BEFORE
 * creating new branches, ensuring workspaces start from the latest remote state
 * rather than a stale local/bundled state.
 *
 * Test setup:
 * 1. Create a local repo with a bare clone as origin
 * 2. Push to origin, then add a new commit directly to origin
 * 3. Create a workspace with a new branch
 * 4. Verify the branch contains the origin commit (not just local state)
 *
 * Note: SSH runtime tests with network-accessible origin are limited because:
 * - The SSH container can't access local filesystem paths like /tmp/origin
 * - Testing with real GitHub repos would be flaky and slow
 * - We focus on verifying fallback behavior and that init completes successfully
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { shouldRunIntegrationTests, createTestEnvironment, cleanupTestEnvironment } from "../setup";
import {
  generateBranchName,
  cleanupTempGitRepo,
  waitForInitComplete,
  trustProject,
} from "../helpers";
import { detectDefaultTrunkBranch } from "../../../src/node/git";
import {
  isDockerAvailable,
  startSSHServer,
  stopSSHServer,
  type SSHServerConfig,
} from "../../runtime/test-fixtures/ssh-fixture";
import type { RuntimeConfig } from "../../../src/common/types/runtime";
import { sshConnectionPool } from "../../../src/node/runtime/sshConnectionPool";
import { ssh2ConnectionPool } from "../../../src/node/runtime/SSH2ConnectionPool";

const execAsync = promisify(exec);

const TEST_TIMEOUT_MS = 60000;
const SSH_INIT_WAIT_MS = 15000; // SSH init includes sync + checkout, needs more time
const ORIGIN_COMMIT_MARKER = "ORIGIN_ONLY_COMMIT_MARKER";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// SSH server config (shared across all SSH tests)
let sshConfig: SSHServerConfig | undefined;

/**
 * Create a temp git repo with a bare origin, where origin has a commit
 * that the local repo does NOT have.
 *
 * Returns:
 * - repoPath: local working repo
 * - originPath: bare origin repo
 * - originCommitHash: the commit hash that exists only on origin
 */
async function createRepoWithAheadOrigin(): Promise<{
  repoPath: string;
  originPath: string;
  originCommitHash: string;
  trunkBranch: string;
}> {
  // Create local repo
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "mux-test-repo-"));
  await execAsync(`git init`, { cwd: repoPath });
  await execAsync(
    `git config user.email "test@example.com" && git config user.name "Test User" && git config commit.gpgsign false`,
    { cwd: repoPath }
  );
  await execAsync(`echo "initial" > README.md && git add . && git commit -m "Initial commit"`, {
    cwd: repoPath,
  });

  const trunkBranch = await detectDefaultTrunkBranch(repoPath);

  // Create bare origin from local repo
  const originPath = await fs.mkdtemp(path.join(os.tmpdir(), "mux-test-origin-"));
  await execAsync(`git clone --bare "${repoPath}" "${originPath}"`);

  // Add origin remote to local repo
  await execAsync(`git remote add origin "${originPath}"`, { cwd: repoPath });
  await execAsync(`git fetch origin`, { cwd: repoPath });
  await execAsync(`git branch --set-upstream-to=origin/${trunkBranch} ${trunkBranch}`, {
    cwd: repoPath,
  });

  // Now add a commit DIRECTLY to origin (simulating someone else pushing)
  // We do this by creating a temp clone, committing, and pushing
  const tempClone = await fs.mkdtemp(path.join(os.tmpdir(), "mux-test-clone-"));
  await execAsync(`git clone "${originPath}" "${tempClone}"`);
  await execAsync(
    `git config user.email "test@example.com" && git config user.name "Test User" && git config commit.gpgsign false`,
    { cwd: tempClone }
  );
  await execAsync(
    `echo "${ORIGIN_COMMIT_MARKER}" > origin-only.txt && git add . && git commit -m "Origin-only commit"`,
    { cwd: tempClone }
  );
  await execAsync(`git push origin ${trunkBranch}`, { cwd: tempClone });

  // Get the commit hash
  const { stdout: commitHash } = await execAsync(`git rev-parse HEAD`, { cwd: tempClone });
  const originCommitHash = commitHash.trim();

  // Cleanup temp clone
  await fs.rm(tempClone, { recursive: true, force: true });

  // At this point:
  // - repoPath has only "Initial commit"
  // - originPath (bare) has "Initial commit" + "Origin-only commit"
  // - The local repo has NOT fetched the new commit

  return { repoPath, originPath, originCommitHash, trunkBranch };
}

/**
 * Cleanup all temp directories created for test
 */
async function cleanupTestRepos(repoPath: string, originPath: string): Promise<void> {
  await Promise.all([
    cleanupTempGitRepo(repoPath),
    fs.rm(originPath, { recursive: true, force: true }).catch(() => {}),
  ]);
}

describeIntegration("Origin fetch ordering during workspace creation", () => {
  beforeAll(async () => {
    if (!(await isDockerAvailable())) {
      throw new Error(
        "Docker is required for SSH runtime tests. Please install Docker or skip tests by unsetting TEST_INTEGRATION."
      );
    }

    console.log("Starting SSH server container for originFetch tests...");
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
    sshConnectionPool.clearAllHealthForTests();
    ssh2ConnectionPool.clearAllHealthForTests();
  });

  // Worktree tests - can test full origin fetch behavior
  describe("Runtime: worktree", () => {
    test.concurrent(
      "new branch starts from origin/trunk, not stale local trunk",
      async () => {
        const env = await createTestEnvironment();
        const { repoPath, originPath, originCommitHash, trunkBranch } =
          await createRepoWithAheadOrigin();

        try {
          const branchName = generateBranchName("origin-fetch-test");

          // Create workspace with new branch
          await trustProject(env, repoPath);
          const result = await env.orpc.workspace.create({
            projectPath: repoPath,
            branchName,
            trunkBranch,
          });

          expect(result.success).toBe(true);
          if (!result.success) {
            throw new Error(`Failed to create workspace: ${result.error}`);
          }

          const workspaceId = result.metadata.id;

          // Execute git command in workspace to check if origin commit is present
          const execResult = await env.orpc.workspace.executeBash({
            workspaceId,
            script: `git log --oneline | head -5`,
          });

          expect(execResult.success).toBe(true);
          if (!execResult.success || !execResult.data) {
            throw new Error(`Failed to execute git log`);
          }

          const gitLog = execResult.data.output;

          // The origin-only commit should be in the log
          // Check for the short hash (first 7 chars)
          const shortHash = originCommitHash.substring(0, 7);
          expect(gitLog).toContain(shortHash);

          // Also verify the marker file exists
          const fileCheck = await env.orpc.workspace.executeBash({
            workspaceId,
            script: `cat origin-only.txt`,
          });

          expect(fileCheck.success).toBe(true);
          if (fileCheck.success && fileCheck.data) {
            expect((fileCheck.data.output ?? "").trim()).toBe(ORIGIN_COMMIT_MARKER);
          }

          // Cleanup workspace
          await env.orpc.workspace.remove({ workspaceId });
        } finally {
          await cleanupTestEnvironment(env);
          await cleanupTestRepos(repoPath, originPath);
        }
      },
      TEST_TIMEOUT_MS
    );

    test.concurrent(
      "existing branch fast-forwards to origin after checkout",
      async () => {
        const env = await createTestEnvironment();
        const { repoPath, originPath, originCommitHash, trunkBranch } =
          await createRepoWithAheadOrigin();

        try {
          // First, create the branch locally (before fetching origin)
          const branchName = generateBranchName("existing-branch-test");
          await execAsync(`git checkout -b ${branchName}`, { cwd: repoPath });
          await execAsync(`git checkout ${trunkBranch}`, { cwd: repoPath });

          // The local branch exists but doesn't have the origin commit

          // Create workspace with the existing branch
          await trustProject(env, repoPath);
          const result = await env.orpc.workspace.create({
            projectPath: repoPath,
            branchName,
            trunkBranch,
          });

          expect(result.success).toBe(true);
          if (!result.success) {
            throw new Error(`Failed to create workspace: ${result.error}`);
          }

          const workspaceId = result.metadata.id;

          // The workspace should have fast-forwarded to include the origin commit
          const execResult = await env.orpc.workspace.executeBash({
            workspaceId,
            script: `git log --oneline | head -5`,
          });

          expect(execResult.success).toBe(true);
          if (!execResult.success || !execResult.data) {
            throw new Error(`Failed to execute git log`);
          }

          const gitLog = execResult.data.output;
          const shortHash = originCommitHash.substring(0, 7);

          // After fast-forward, the origin commit should be present
          expect(gitLog).toContain(shortHash);

          // Cleanup workspace
          await env.orpc.workspace.remove({ workspaceId });
        } finally {
          await cleanupTestEnvironment(env);
          await cleanupTestRepos(repoPath, originPath);
        }
      },
      TEST_TIMEOUT_MS
    );

    test.concurrent(
      "gracefully falls back to local trunk when origin is unreachable",
      async () => {
        const env = await createTestEnvironment();

        // Create a repo with a fake origin URL that doesn't exist
        const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "mux-test-repo-"));
        await execAsync(`git init`, { cwd: repoPath });
        await execAsync(
          `git config user.email "test@example.com" && git config user.name "Test User" && git config commit.gpgsign false`,
          { cwd: repoPath }
        );
        await execAsync(
          `echo "initial" > README.md && git add . && git commit -m "Initial commit"`,
          { cwd: repoPath }
        );

        // Add a fake origin that won't be reachable
        await execAsync(`git remote add origin git@github.com:nonexistent/repo.git`, {
          cwd: repoPath,
        });

        const trunkBranch = await detectDefaultTrunkBranch(repoPath);

        try {
          const branchName = generateBranchName("fallback-test");

          // Create workspace - should succeed despite unreachable origin
          await trustProject(env, repoPath);
          const result = await env.orpc.workspace.create({
            projectPath: repoPath,
            branchName,
            trunkBranch,
          });

          // Should still succeed (fallback to local trunk)
          expect(result.success).toBe(true);
          if (!result.success) {
            throw new Error(`Failed to create workspace: ${result.error}`);
          }

          const workspaceId = result.metadata.id;

          // Verify the workspace is usable
          const execResult = await env.orpc.workspace.executeBash({
            workspaceId,
            script: `cat README.md`,
          });

          expect(execResult.success).toBe(true);
          if (execResult.success && execResult.data) {
            expect((execResult.data.output ?? "").trim()).toBe("initial");
          }

          // Cleanup workspace
          await env.orpc.workspace.remove({ workspaceId });
        } finally {
          await cleanupTestEnvironment(env);
          await cleanupTempGitRepo(repoPath);
        }
      },
      TEST_TIMEOUT_MS
    );

    test.concurrent(
      "preserves local trunk when local is ahead of origin (unpushed work)",
      async () => {
        const env = await createTestEnvironment();

        // Create a repo with origin, then add an unpushed local commit
        const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "mux-test-repo-"));
        await execAsync(`git init`, { cwd: repoPath });
        await execAsync(
          `git config user.email "test@example.com" && git config user.name "Test User" && git config commit.gpgsign false`,
          { cwd: repoPath }
        );
        await execAsync(
          `echo "initial" > README.md && git add . && git commit -m "Initial commit"`,
          { cwd: repoPath }
        );

        const trunkBranch = await detectDefaultTrunkBranch(repoPath);

        // Create bare origin from local repo
        const originPath = await fs.mkdtemp(path.join(os.tmpdir(), "mux-test-origin-"));
        await execAsync(`git clone --bare "${repoPath}" "${originPath}"`);

        // Add origin remote to local repo
        await execAsync(`git remote add origin "${originPath}"`, { cwd: repoPath });
        await execAsync(`git fetch origin`, { cwd: repoPath });
        await execAsync(`git branch --set-upstream-to=origin/${trunkBranch} ${trunkBranch}`, {
          cwd: repoPath,
        });

        // Add an UNPUSHED commit locally (local is ahead of origin)
        const localOnlyMarker = "LOCAL_ONLY_UNPUSHED_COMMIT";
        await execAsync(
          `echo "${localOnlyMarker}" > local-only.txt && git add . && git commit -m "Local unpushed commit"`,
          { cwd: repoPath }
        );

        // Get the local commit hash
        const { stdout: localCommitHash } = await execAsync(`git rev-parse HEAD`, {
          cwd: repoPath,
        });
        const localShortHash = localCommitHash.trim().substring(0, 7);

        try {
          const branchName = generateBranchName("local-ahead-test");

          // Create workspace - should preserve local unpushed work
          await trustProject(env, repoPath);
          const result = await env.orpc.workspace.create({
            projectPath: repoPath,
            branchName,
            trunkBranch,
          });

          expect(result.success).toBe(true);
          if (!result.success) {
            throw new Error(`Failed to create workspace: ${result.error}`);
          }

          const workspaceId = result.metadata.id;

          // Verify the workspace contains the LOCAL commit (not just origin)
          const execResult = await env.orpc.workspace.executeBash({
            workspaceId,
            script: `git log --oneline | head -5`,
          });

          expect(execResult.success).toBe(true);
          if (!execResult.success || !execResult.data) {
            throw new Error(`Failed to execute git log`);
          }

          // The local unpushed commit should be in the log
          expect(execResult.data.output).toContain(localShortHash);

          // Also verify the local-only file exists
          const fileCheck = await env.orpc.workspace.executeBash({
            workspaceId,
            script: `cat local-only.txt`,
          });

          expect(fileCheck.success).toBe(true);
          if (fileCheck.success && fileCheck.data) {
            expect((fileCheck.data.output ?? "").trim()).toBe(localOnlyMarker);
          }

          // Cleanup workspace
          await env.orpc.workspace.remove({ workspaceId });
        } finally {
          await cleanupTestEnvironment(env);
          await cleanupTestRepos(repoPath, originPath);
        }
      },
      TEST_TIMEOUT_MS
    );
  });

  // SSH tests - origin is inaccessible from remote, so we test fallback behavior
  // The SSH container can't access local filesystem paths, so origin fetch will fail
  // and we verify graceful fallback to bundled local state
  describe("Runtime: ssh", () => {
    const getSSHRuntimeConfig = (): RuntimeConfig => {
      if (!sshConfig) {
        throw new Error("SSH server not initialized");
      }
      return {
        type: "ssh",
        host: `testuser@localhost`,
        srcBaseDir: sshConfig.workdir,
        identityFile: sshConfig.privateKeyPath,
        port: sshConfig.port,
      };
    };

    test.concurrent(
      "creates workspace from bundled local state when origin is inaccessible from remote",
      async () => {
        const env = await createTestEnvironment();
        const { repoPath, originPath, trunkBranch } = await createRepoWithAheadOrigin();

        try {
          const branchName = generateBranchName("ssh-fallback-test");
          const runtimeConfig = getSSHRuntimeConfig();

          // Create workspace - origin fetch will fail (local path inaccessible from SSH),
          // but workspace should still be created from bundled local state
          await trustProject(env, repoPath);
          const result = await env.orpc.workspace.create({
            projectPath: repoPath,
            branchName,
            trunkBranch,
            runtimeConfig,
          });

          expect(result.success).toBe(true);
          if (!result.success) {
            throw new Error(`Failed to create workspace: ${result.error}`);
          }

          const workspaceId = result.metadata.id;

          // Wait for SSH init to complete
          await waitForInitComplete(env, workspaceId, SSH_INIT_WAIT_MS);

          // Verify workspace has the local state (Initial commit)
          const execResult = await env.orpc.workspace.executeBash({
            workspaceId,
            script: `git log --oneline | head -3`,
          });

          expect(execResult.success).toBe(true);
          if (!execResult.success || !execResult.data) {
            throw new Error(`Failed to execute git log`);
          }

          // Should have the initial commit (from bundled local state)
          expect(execResult.data.output).toContain("Initial commit");

          // Cleanup workspace
          await env.orpc.workspace.remove({ workspaceId });
        } finally {
          await cleanupTestEnvironment(env);
          await cleanupTestRepos(repoPath, originPath);
        }
      },
      TEST_TIMEOUT_MS
    );

    test.concurrent(
      "gracefully handles unreachable origin URL",
      async () => {
        const env = await createTestEnvironment();

        // Create a repo with a fake origin URL
        const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "mux-test-repo-"));
        await execAsync(`git init`, { cwd: repoPath });
        await execAsync(
          `git config user.email "test@example.com" && git config user.name "Test User" && git config commit.gpgsign false`,
          { cwd: repoPath }
        );
        await execAsync(
          `echo "initial" > README.md && git add . && git commit -m "Initial commit"`,
          { cwd: repoPath }
        );
        await execAsync(`git remote add origin git@github.com:nonexistent/repo.git`, {
          cwd: repoPath,
        });

        const trunkBranch = await detectDefaultTrunkBranch(repoPath);

        try {
          const branchName = generateBranchName("ssh-unreachable-origin");
          const runtimeConfig = getSSHRuntimeConfig();

          await trustProject(env, repoPath);
          const result = await env.orpc.workspace.create({
            projectPath: repoPath,
            branchName,
            trunkBranch,
            runtimeConfig,
          });

          expect(result.success).toBe(true);
          if (!result.success) {
            throw new Error(`Failed to create workspace: ${result.error}`);
          }

          const workspaceId = result.metadata.id;

          // Wait for init and verify workspace is usable
          await waitForInitComplete(env, workspaceId, SSH_INIT_WAIT_MS);

          const execResult = await env.orpc.workspace.executeBash({
            workspaceId,
            script: `cat README.md`,
          });

          expect(execResult.success).toBe(true);
          if (execResult.success && execResult.data) {
            expect((execResult.data.output ?? "").trim()).toBe("initial");
          }

          await env.orpc.workspace.remove({ workspaceId });
        } finally {
          await cleanupTestEnvironment(env);
          await cleanupTempGitRepo(repoPath);
        }
      },
      TEST_TIMEOUT_MS
    );
  });
});
