/**
 * Integration tests for bash execution across Local and SSH runtimes
 *
 * Tests bash tool using real ORPC handlers on both LocalRuntime and SSHRuntime.
 *
 * Reuses test infrastructure from runtimeFileEditing.test.ts
 */

import {
  createTestEnvironment,
  cleanupTestEnvironment,
  shouldRunIntegrationTests,
  validateApiKeys,
  getApiKey,
  setupProviders,
} from "../setup";
import {
  createTempGitRepo,
  cleanupTempGitRepo,
  generateBranchName,
  createWorkspaceWithInit,
  sendMessageAndWait,
  HAIKU_MODEL,
  STREAM_TIMEOUT_LOCAL_MS,
  STREAM_TIMEOUT_SSH_MS,
  TEST_TIMEOUT_LOCAL_MS,
  TEST_TIMEOUT_SSH_MS,
  getTestRunner,
  createStreamCollector,
} from "../helpers";
import {
  isDockerAvailable,
  startSSHServer,
  stopSSHServer,
  type SSHServerConfig,
} from "../../runtime/test-fixtures/ssh-fixture";
import type { RuntimeConfig } from "../../../src/common/types/runtime";
import type { TestEnvironment } from "../setup";
import { sshConnectionPool } from "../../../src/node/runtime/sshConnectionPool";
import { ssh2ConnectionPool } from "../../../src/node/runtime/SSH2ConnectionPool";
import type { WorkspaceChatMessage } from "../../../src/common/orpc/types";
import type { ToolPolicy } from "../../../src/common/utils/tools/toolPolicy";

// Tool policy: Only allow the bash tool.
const BASH_ONLY: ToolPolicy = [{ regex_match: "bash", action: "require" }];

/**
 * Collect tool outputs from stream events
 */
function collectToolOutputs(events: WorkspaceChatMessage[], toolName: string): string {
  return events
    .filter(
      (event) =>
        "type" in event &&
        event.type === "tool-call-end" &&
        "toolName" in event &&
        event.toolName === toolName
    )
    .map((event) => {
      const result = (event as { result?: { output?: string } }).result;
      const text = result?.output;
      return typeof text === "string" ? text : "";
    })
    .join("\n");
}

/**
 * Calculate tool execution duration from captured events.
 * Returns duration in milliseconds, or -1 if events not found.
 */
function getToolDuration(events: WorkspaceChatMessage[], toolName: string): number {
  const startEvent = events.find(
    (e) => "type" in e && e.type === "tool-call-start" && "toolName" in e && e.toolName === toolName
  ) as { toolCallId?: string; timestamp?: number } | undefined;

  if (!startEvent?.toolCallId || !startEvent.timestamp) {
    return -1;
  }

  const endEvent = events.find(
    (e) =>
      "type" in e &&
      e.type === "tool-call-end" &&
      "toolName" in e &&
      e.toolName === toolName &&
      "toolCallId" in e &&
      e.toolCallId === startEvent.toolCallId
  ) as { timestamp?: number } | undefined;

  if (endEvent?.timestamp) {
    return endEvent.timestamp - startEvent.timestamp;
  }
  return -1;
}

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

// SSH server config (shared across all SSH tests)
let sshConfig: SSHServerConfig | undefined;

describeIntegration("Runtime Bash Execution", () => {
  beforeAll(async () => {
    // Check if Docker is available (required for SSH tests)
    if (!(await isDockerAvailable())) {
      throw new Error(
        "Docker is required for SSH runtime tests. Please install Docker or skip tests by unsetting TEST_INTEGRATION."
      );
    }

    // Start SSH server (shared across all tests for speed)
    console.log("Starting SSH server container for bash tests...");
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

  // Test matrix: Run tests for both local and SSH runtimes
  describe.each<{ type: "local" | "ssh" }>([{ type: "local" }, { type: "ssh" }])(
    "Runtime: $type",
    ({ type }) => {
      // Helper to build runtime config
      const getRuntimeConfig = (branchName: string): RuntimeConfig | undefined => {
        if (type === "ssh" && sshConfig) {
          return {
            type: "ssh",
            host: `testuser@localhost`,
            srcBaseDir: `${sshConfig.workdir}/${branchName}`,
            identityFile: sshConfig.privateKeyPath,
            port: sshConfig.port,
          };
        }
        return undefined; // undefined = defaults to local
      };

      const streamTimeoutMs = type === "ssh" ? STREAM_TIMEOUT_SSH_MS : STREAM_TIMEOUT_LOCAL_MS;

      // SSH tests run serially to avoid Docker container overload
      const runTest = getTestRunner(type);

      // #6588: an ssh test here ran into jest's 120 s limit in the merge queue, and that message
      // does not say which step hung. Each ssh test now waits for init-end with its own budget
      // and records its current step; a watchdog fails it before jest's limit with that step,
      // the last init lines and the SSH pool's health.
      const SSH_INIT_BUDGET_MS = 40_000;
      const SSH_WATCHDOG_MS = TEST_TIMEOUT_SSH_MS - 10_000;
      interface StepContext {
        step: string;
        initLines: string[];
      }
      const describeSsh = (ctx: StepContext): string => {
        const health =
          sshConfig &&
          sshConnectionPool.getConnectionHealth({
            host: "testuser@localhost",
            port: sshConfig.port,
            identityFile: sshConfig.privateKeyPath,
          });
        return (
          `Last init lines: ${JSON.stringify(ctx.initLines.slice(-5))}. ` +
          // CI runs the default OpenSSH transport. The SSH2 pool exposes no health to read.
          `OpenSSH pool: ${JSON.stringify(health ?? null)}`
        );
      };
      /** Runs an ssh test body under the watchdog; local tests run unchanged. */
      const watched = (body: (ctx: StepContext) => Promise<void>) => async (): Promise<void> => {
        const ctx: StepContext = { step: "setup", initLines: [] };
        if (type !== "ssh") return body(ctx);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const watchdog = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const where = `still in step "${ctx.step}" after ${SSH_WATCHDOG_MS} ms`;
            reject(new Error(`ssh test ${where} (#6588). ${describeSsh(ctx)}`));
          }, SSH_WATCHDOG_MS);
        });
        try {
          await Promise.race([body(ctx), watchdog]);
        } finally {
          clearTimeout(timer);
        }
      };
      /** Creates the workspace; for ssh, init-end must arrive within its budget. */
      const createWorkspace = async (
        env: TestEnvironment,
        repo: string,
        branchName: string,
        ctx: StepContext
      ) => {
        ctx.step = "create workspace";
        const created = await createWorkspaceWithInit(
          env,
          repo,
          branchName,
          getRuntimeConfig(branchName),
          type !== "ssh" // local keeps the helper's short, soft init wait
        );
        if (type !== "ssh") return created;
        ctx.step = "wait for init-end";
        const collector = createStreamCollector(env.orpc, created.workspaceId);
        collector.start();
        try {
          const end = await collector.waitForEvent("init-end", SSH_INIT_BUDGET_MS);
          ctx.initLines = collector
            .getEvents()
            .flatMap((e) => ("type" in e && e.type === "init-output" ? [e.line] : []));
          if (end == null) {
            const message = `ssh init did not end within ${SSH_INIT_BUDGET_MS} ms (#6588). ${describeSsh(ctx)}`;
            // The caller never gets `cleanup` on this path, so remove the workspace here. Bounded:
            // a removal that hangs too must not hide the init message behind the watchdog.
            await Promise.race([
              created.cleanup().catch(() => undefined),
              new Promise((resolve) => setTimeout(resolve, 10_000)),
            ]);
            throw new Error(message);
          }
        } finally {
          collector.stop();
        }
        return created;
      };

      runTest(
        "should execute simple bash command",
        watched(async (ctx) => {
          const env = await createTestEnvironment();
          const tempGitRepo = await createTempGitRepo();

          try {
            // Setup provider
            await setupProviders(env, {
              anthropic: {
                apiKey: getApiKey("ANTHROPIC_API_KEY"),
              },
            });

            // Create workspace
            const branchName = generateBranchName("bash-simple");
            const { workspaceId, cleanup } = await createWorkspace(
              env,
              tempGitRepo,
              branchName,
              ctx
            );

            ctx.step = "turn";
            try {
              // Ask AI to run a simple command
              const events = await sendMessageAndWait(
                env,
                workspaceId,
                'Use the bash tool with args: { script: "echo Hello World", timeout_secs: 30, run_in_background: false, display_name: "echo-hello" }. Do not spawn a sub-agent.',
                HAIKU_MODEL,
                BASH_ONLY,
                streamTimeoutMs
              );

              // Verify the command output appears in the bash tool result.
              const bashOutput = collectToolOutputs(events, "bash");
              expect(bashOutput.toLowerCase()).toContain("hello world");

              // Do not assert on free-form assistant narration here. Some runs only emit
              // a preamble sentence while still executing the tool correctly.

              // Verify bash was called
              const toolCallStarts = events.filter(
                (e) => "type" in e && e.type === "tool-call-start"
              );
              const bashCall = toolCallStarts.find((e) => {
                if (!("toolName" in e) || e.toolName !== "bash") return false;
                const args = (e as { args?: { script?: string } }).args;
                return typeof args?.script === "string" && args.script.includes("echo Hello World");
              });
              expect(bashCall).toBeDefined();
            } finally {
              ctx.step = "remove workspace";
              await cleanup();
            }
          } finally {
            ctx.step = "clean up the test environment";
            await cleanupTempGitRepo(tempGitRepo);
            await cleanupTestEnvironment(env);
          }
        }),
        type === "ssh" ? TEST_TIMEOUT_SSH_MS : TEST_TIMEOUT_LOCAL_MS
      );

      runTest(
        "should handle bash command with environment variables",
        watched(async (ctx) => {
          const env = await createTestEnvironment();
          const tempGitRepo = await createTempGitRepo();

          try {
            // Setup provider
            await setupProviders(env, {
              anthropic: {
                apiKey: getApiKey("ANTHROPIC_API_KEY"),
              },
            });

            // Create workspace
            const branchName = generateBranchName("bash-env");
            const { workspaceId, cleanup } = await createWorkspace(
              env,
              tempGitRepo,
              branchName,
              ctx
            );

            ctx.step = "turn";
            try {
              // Ask AI to run command that sets and uses env var
              const events = await sendMessageAndWait(
                env,
                workspaceId,
                'Use the bash tool with args: { script: "export TEST_VAR=test123 && echo Value:$TEST_VAR", timeout_secs: 30, run_in_background: false, display_name: "env-var" }. Do not spawn a sub-agent.',
                HAIKU_MODEL,
                BASH_ONLY,
                streamTimeoutMs
              );

              // Verify the env var value appears in the bash tool output.
              const bashOutput = collectToolOutputs(events, "bash");
              expect(bashOutput).toContain("test123");

              // Do not assert on free-form assistant narration here. Some runs only emit
              // a preamble sentence while still executing the tool correctly.

              // Verify bash was called
              const toolCallStarts = events.filter(
                (e) => "type" in e && e.type === "tool-call-start"
              );
              const bashCall = toolCallStarts.find((e) => {
                if (!("toolName" in e) || e.toolName !== "bash") return false;
                const args = (e as { args?: { script?: string } }).args;
                return (
                  typeof args?.script === "string" &&
                  args.script.includes("export TEST_VAR=test123")
                );
              });
              expect(bashCall).toBeDefined();
            } finally {
              ctx.step = "remove workspace";
              await cleanup();
            }
          } finally {
            ctx.step = "clean up the test environment";
            await cleanupTempGitRepo(tempGitRepo);
            await cleanupTestEnvironment(env);
          }
        }),
        type === "ssh" ? TEST_TIMEOUT_SSH_MS : TEST_TIMEOUT_LOCAL_MS
      );

      // SSH runtime shares a single container; run this stdin regression sequentially to avoid contention.
      const runStdinTest = type === "ssh" ? test : test.concurrent;

      runStdinTest(
        "should not hang on commands that read stdin without input",
        watched(async (ctx) => {
          const env = await createTestEnvironment();
          const tempGitRepo = await createTempGitRepo();

          try {
            // Setup provider
            await setupProviders(env, {
              anthropic: {
                apiKey: getApiKey("ANTHROPIC_API_KEY"),
              },
            });

            // Create workspace
            const branchName = generateBranchName("bash-stdin");
            const { workspaceId, cleanup } = await createWorkspace(
              env,
              tempGitRepo,
              branchName,
              ctx
            );

            ctx.step = "turn";
            try {
              // Test command that pipes a file through a stdin-reading command (grep)
              // This would hang forever if stdin.close() was used instead of stdin.abort()
              // Regression test for: https://github.com/coder/mux/issues/503
              const events = await sendMessageAndWait(
                env,
                workspaceId,
                'Use the bash tool with args: { script: "echo testdata > /tmp/test.txt && cat /tmp/test.txt | grep test", timeout_secs: 30, run_in_background: false, display_name: "stdin-grep" }. Do not spawn a sub-agent.',
                HAIKU_MODEL,
                BASH_ONLY,
                streamTimeoutMs
              );

              // Calculate actual tool execution duration
              const toolDuration = getToolDuration(events, "bash");

              // Verify command completed successfully (not timeout)
              // We primarily check bashOutput to ensure the tool executed and didn't hang
              const bashOutput = collectToolOutputs(events, "bash");
              expect(bashOutput).toContain("testdata");

              // Do not assert on free-form assistant narration here. Some runs only emit
              // a preamble sentence while still executing the tool correctly.

              // Verify command completed quickly (not hanging until timeout)
              expect(toolDuration).toBeGreaterThan(0);
              const maxDuration = 10000;
              expect(toolDuration).toBeLessThan(maxDuration);

              // Verify bash was called
              const toolCallStarts = events.filter(
                (e) => "type" in e && e.type === "tool-call-start"
              );
              const bashCalls = toolCallStarts.filter(
                (e) => "toolName" in e && e.toolName === "bash"
              );
              expect(bashCalls.length).toBeGreaterThan(0);
            } finally {
              ctx.step = "remove workspace";
              await cleanup();
            }
          } finally {
            ctx.step = "clean up the test environment";
            await cleanupTempGitRepo(tempGitRepo);
            await cleanupTestEnvironment(env);
          }
        }),
        type === "ssh" ? TEST_TIMEOUT_SSH_MS : TEST_TIMEOUT_LOCAL_MS
      );

      runTest(
        "should not hang on grep | head pattern over SSH",
        watched(async (ctx) => {
          const env = await createTestEnvironment();
          const tempGitRepo = await createTempGitRepo();

          try {
            // Setup provider
            await setupProviders(env, {
              anthropic: {
                apiKey: getApiKey("ANTHROPIC_API_KEY"),
              },
            });

            // Create workspace
            const branchName = generateBranchName("bash-grep-head");
            const { workspaceId, cleanup } = await createWorkspace(
              env,
              tempGitRepo,
              branchName,
              ctx
            );

            ctx.step = "turn";
            try {
              // Test grep | head pattern - this historically hangs over SSH
              // This is a regression test for the bash hang issue
              const events = await sendMessageAndWait(
                env,
                workspaceId,
                'Use the bash tool with args: { script: "for i in {1..1000}; do echo "terminal bench line $i" >> testfile.txt; done && grep -n "terminal bench" testfile.txt | head -n 200", timeout_secs: 60, run_in_background: false, display_name: "grep-head" }. Do not spawn a sub-agent.',
                HAIKU_MODEL,
                BASH_ONLY,
                streamTimeoutMs
              );

              // Calculate actual tool execution duration
              const toolDuration = getToolDuration(events, "bash");

              // Verify command completed successfully (not timeout)
              // Check that bash completed (tool-call-end events exist)
              const toolCallEnds = events.filter(
                (e) =>
                  "type" in e &&
                  e.type === "tool-call-end" &&
                  "toolName" in e &&
                  e.toolName === "bash"
              );
              expect(toolCallEnds.length).toBeGreaterThan(0);

              // Verify command completed quickly (not hanging until timeout)
              // SSH runtime should complete in <10s even with high latency
              expect(toolDuration).toBeGreaterThan(0);
              const maxDuration = 15000;
              expect(toolDuration).toBeLessThan(maxDuration);

              // Verify bash was called
              const toolCallStarts = events.filter(
                (e) => "type" in e && e.type === "tool-call-start"
              );
              const bashCalls = toolCallStarts.filter(
                (e) => "toolName" in e && e.toolName === "bash"
              );
              expect(bashCalls.length).toBeGreaterThan(0);
            } finally {
              ctx.step = "remove workspace";
              await cleanup();
            }
          } finally {
            ctx.step = "clean up the test environment";
            await cleanupTempGitRepo(tempGitRepo);
            await cleanupTestEnvironment(env);
          }
        }),
        type === "ssh" ? TEST_TIMEOUT_SSH_MS : TEST_TIMEOUT_LOCAL_MS
      );
    }
  );
});
