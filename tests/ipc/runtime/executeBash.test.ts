import { shouldRunIntegrationTests, createTestEnvironment, cleanupTestEnvironment } from "../setup";
import {
  createTempGitRepo,
  cleanupTempGitRepo,
  createWorkspace,
  waitFor,
  waitForInitComplete,
  resolveOrpcClient,
  configureTestRetries,
} from "../helpers";
import type { WorkspaceMetadata } from "../../../src/common/types/workspace";

type WorkspaceCreationResult = Awaited<ReturnType<typeof createWorkspace>>;

type OrpcClient = ReturnType<typeof resolveOrpcClient>;

type ExecuteBashResult = Awaited<ReturnType<OrpcClient["workspace"]["executeBash"]>>;

async function executeBashUntilReady(
  client: OrpcClient,
  workspaceId: string,
  script: string,
  timeoutMs = 5000
): Promise<ExecuteBashResult> {
  let lastResult: ExecuteBashResult | null = null;
  // Widened explicitly: assignments inside the waitFor callback are invisible to narrowing.
  let lastFailure = null as string | null;

  const ready = await waitFor(async () => {
    try {
      lastResult = await client.workspace.executeBash({ workspaceId, script });
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
      return false;
    }

    if (!lastResult.success) {
      lastFailure = lastResult.error;
      return false;
    }

    if (!lastResult.data.success) {
      const outputSnippet = lastResult.data.output?.slice(0, 200) ?? "";
      const outputDetail = outputSnippet.length > 0 ? ` Output: ${outputSnippet}` : "";
      lastFailure =
        lastResult.data.error ?? `exit code ${lastResult.data.exitCode}.${outputDetail}`;
      return false;
    }

    return true;
  }, timeoutMs);

  if (!ready || !lastResult) {
    const detail = lastFailure ? ` Last failure: ${lastFailure}` : "";
    throw new Error(`executeBash did not succeed within ${timeoutMs}ms.${detail}`);
  }

  return lastResult;
}

function expectWorkspaceCreationSuccess(result: WorkspaceCreationResult): WorkspaceMetadata {
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error(`Expected workspace creation to succeed, but it failed: ${result.error}`);
  }
  return result.metadata;
}

const GIT_FETCH_TIMEOUT_SECS = process.platform === "win32" ? 15 : 5;
const TEST_TIMEOUT_MS = process.platform === "win32" ? 60_000 : 15_000;
// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Retry flaky integration tests in CI (Windows shell startup / IO jitter)
configureTestRetries(2);

describeIntegration("executeBash", () => {
  test.concurrent(
    "should execute bash command in workspace context",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        // Create a workspace
        const createResult = await createWorkspace(env, tempGitRepo, "test-bash");
        const metadata = expectWorkspaceCreationSuccess(createResult);
        const workspaceId = metadata.id;
        const client = resolveOrpcClient(env);

        // Execute a simple bash command (pwd should return workspace path)
        const pwdResult = await client.workspace.executeBash({ workspaceId, script: "pwd" });

        expect(pwdResult.success).toBe(true);
        if (!pwdResult.success) return;
        expect(pwdResult.data.success).toBe(true);
        // Verify pwd output contains the workspace name (directories are named with workspace names)
        expect(pwdResult.data.output).toContain(metadata.name);
        expect(pwdResult.data.exitCode).toBe(0);

        // Clean up
        await client.workspace.remove({ workspaceId });
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    TEST_TIMEOUT_MS
  );

  test.concurrent(
    "should execute git status in workspace context",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        // Create a workspace
        const createResult = await createWorkspace(env, tempGitRepo, "test-git-status");
        const workspaceId = expectWorkspaceCreationSuccess(createResult).id;
        const client = resolveOrpcClient(env);

        // Execute git status
        const gitStatusResult = await client.workspace.executeBash({
          workspaceId,
          script: "git status",
        });

        expect(gitStatusResult.success).toBe(true);
        if (!gitStatusResult.success) return;
        expect(gitStatusResult.data.success).toBe(true);
        expect(gitStatusResult.data.output).toContain("On branch");
        expect(gitStatusResult.data.exitCode).toBe(0);

        // Clean up
        await client.workspace.remove({ workspaceId });
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    TEST_TIMEOUT_MS
  );

  test.concurrent(
    "should handle command failure with exit code",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        // Create a workspace
        const createResult = await createWorkspace(env, tempGitRepo, "test-failure");
        const workspaceId = expectWorkspaceCreationSuccess(createResult).id;
        const client = resolveOrpcClient(env);

        // Execute a command that will fail
        const failResult = await client.workspace.executeBash({
          workspaceId,
          script: "exit 42",
        });

        expect(failResult.success).toBe(true);
        if (!failResult.success) return;
        expect(failResult.data.success).toBe(false);
        if (!failResult.data.success) {
          expect(failResult.data.exitCode).toBe(42);
          expect(failResult.data.error).toContain("exited with code 42");
        }

        // Clean up
        await client.workspace.remove({ workspaceId });
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    TEST_TIMEOUT_MS
  );

  test.concurrent(
    "should respect timeout option",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        // Create a workspace
        const createResult = await createWorkspace(env, tempGitRepo, "test-timeout");
        const workspaceId = expectWorkspaceCreationSuccess(createResult).id;
        const client = resolveOrpcClient(env);

        // Execute a command that takes longer than the timeout
        const timeoutResult = await client.workspace.executeBash({
          workspaceId,
          script: "while true; do sleep 0.1; done",
          options: { timeout_secs: 1 },
        });

        expect(timeoutResult.success).toBe(true);
        if (!timeoutResult.success) return;
        expect(timeoutResult.data.success).toBe(false);
        if (!timeoutResult.data.success) {
          expect(timeoutResult.data.error).toContain("timeout");
        }

        // Clean up
        await client.workspace.remove({ workspaceId });
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    TEST_TIMEOUT_MS
  );

  test.concurrent(
    "should handle large output without truncation (IPC uses truncate policy with 10K line limit)",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        // Create a workspace
        const createResult = await createWorkspace(env, tempGitRepo, "test-large-output");
        const workspaceId = expectWorkspaceCreationSuccess(createResult).id;
        const client = resolveOrpcClient(env);

        // Execute a command that generates 400 lines (well under 10K limit for IPC truncate policy)
        const result = await client.workspace.executeBash({
          workspaceId,
          script: "for i in {1..400}; do echo line$i; done",
        });

        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.data.success).toBe(true);
        expect(result.data.exitCode).toBe(0);
        // Should return all 400 lines without truncation
        const lineCount = result.data.output?.split("\n").length ?? 0;
        expect(lineCount).toBe(400);
        // Should not be truncated since 400 << 10,000
        expect(result.data.truncated).toBeUndefined();

        // Clean up
        await client.workspace.remove({ workspaceId });
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    TEST_TIMEOUT_MS
  );

  test.concurrent(
    "should fail gracefully with invalid workspace ID",
    async () => {
      const env = await createTestEnvironment();

      try {
        // Execute bash command with non-existent workspace ID
        const client = resolveOrpcClient(env);
        const result = await client.workspace.executeBash({
          workspaceId: "nonexistent-workspace",
          script: "echo test",
        });

        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.error).toContain("Failed to get workspace metadata");
      } finally {
        await cleanupTestEnvironment(env);
      }
    },
    TEST_TIMEOUT_MS
  );

  test.concurrent(
    "should inject secrets as environment variables",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        // Create a workspace
        const createResult = await createWorkspace(env, tempGitRepo, "test-secrets");
        const workspaceId = expectWorkspaceCreationSuccess(createResult).id;
        const client = resolveOrpcClient(env);

        // Set secrets for the project
        await client.projects.secrets.update({
          projectPath: tempGitRepo,
          secrets: [
            { key: "TEST_SECRET_KEY", value: "secret_value_123" },
            { key: "ANOTHER_SECRET", value: "another_value_456" },
          ],
        });

        // Execute bash command that reads the environment variables
        const echoResult = await client.workspace.executeBash({
          workspaceId,
          script: 'echo "KEY=$TEST_SECRET_KEY ANOTHER=$ANOTHER_SECRET"',
        });

        expect(echoResult.success).toBe(true);
        if (!echoResult.success) return;
        expect(echoResult.data.success).toBe(true);
        expect(echoResult.data.output).toContain("KEY=secret_value_123");
        expect(echoResult.data.output).toContain("ANOTHER=another_value_456");
        expect(echoResult.data.exitCode).toBe(0);

        // Clean up
        await client.workspace.remove({ workspaceId });
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    TEST_TIMEOUT_MS
  );

  test.concurrent(
    "should set GIT_TERMINAL_PROMPT=0 to prevent credential prompts",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        // Create a workspace
        const createResult = await createWorkspace(env, tempGitRepo, "test-git-env");
        const workspaceId = expectWorkspaceCreationSuccess(createResult).id;
        const client = resolveOrpcClient(env);

        // Wait for init to complete (prevents Windows filesystem timing issues)
        await waitForInitComplete(env, workspaceId);

        // Verify GIT_TERMINAL_PROMPT is set to 0
        const gitEnvResult = await executeBashUntilReady(
          client,
          workspaceId,
          'echo "GIT_TERMINAL_PROMPT=$GIT_TERMINAL_PROMPT"',
          10_000
        );

        expect(gitEnvResult.success).toBe(true);
        if (!gitEnvResult.success) return;
        expect(gitEnvResult.data.success).toBe(true);
        if (gitEnvResult.data.success) {
          expect(gitEnvResult.data.output).toContain("GIT_TERMINAL_PROMPT=0");
          expect(gitEnvResult.data.exitCode).toBe(0);
        }

        // Test 1: Verify that git fetch with invalid remote doesn't hang (should fail quickly)
        const invalidFetchResult = await client.workspace.executeBash({
          workspaceId,
          script:
            "git fetch https://invalid-remote-that-does-not-exist-12345.com/repo.git 2>&1 || true",
          options: { timeout_secs: GIT_FETCH_TIMEOUT_SECS },
        });

        expect(invalidFetchResult.success).toBe(true);
        if (!invalidFetchResult.success) return;
        expect(invalidFetchResult.data.success).toBe(true);

        // Avoid a live GitHub fetch here: the env assertion above is the contract, and
        // live HTTPS remotes can exceed the short timeout in network-isolated CI.

        // Clean up
        await client.workspace.remove({ workspaceId });
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    TEST_TIMEOUT_MS
  );
});
