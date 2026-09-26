/**
 * Integration tests for file editing tools across Local and SSH runtimes
 *
 * Tests file_read, file_edit_replace_string, and file_edit_insert tools
 * using real IPC handlers on both LocalRuntime and SSHRuntime.
 *
 * Uses toolPolicy to restrict AI to only file tools (prevents bash circumvention).
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
  extractTextFromEvents,
  configureTestRetries,
  HAIKU_MODEL,
  TEST_TIMEOUT_LOCAL_MS,
  TEST_TIMEOUT_SSH_MS,
  STREAM_TIMEOUT_LOCAL_MS,
  STREAM_TIMEOUT_SSH_MS,
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
import { isToolCallStart, type WorkspaceChatMessage } from "../../../src/common/orpc/types";
import { ssh2ConnectionPool } from "../../../src/node/runtime/SSH2ConnectionPool";
import type { ToolPolicy } from "../../../src/common/utils/tools/toolPolicy";

// Tool policy: Only allow file tools (disable bash to isolate file tool issues)
const FILE_TOOLS_ONLY: ToolPolicy = [
  { regex_match: "file_.*", action: "enable" },
  { regex_match: "bash", action: "disable" },
];

// The stream-end schema has no `error` field; read one defensively if a failed stream carries it.
function streamEndError(event: WorkspaceChatMessage | undefined): unknown {
  return event && "error" in event ? event.error : undefined;
}

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

// Retry flaky tests in CI (API latency/rate limiting)
configureTestRetries();

// SSH server config (shared across all SSH tests)
let sshConfig: SSHServerConfig | undefined;

// ============================================================================
// Tests
// ============================================================================

describeIntegration("Runtime File Editing Tools", () => {
  beforeAll(async () => {
    // Check if Docker is available (required for SSH tests)
    if (!(await isDockerAvailable())) {
      throw new Error(
        "Docker is required for SSH runtime tests. Please install Docker or skip tests by unsetting TEST_INTEGRATION."
      );
    }

    // Start SSH server (shared across all tests for speed)
    console.log("Starting SSH server container for file editing tests...");
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

      // SSH tests run serially to avoid Docker container overload
      const runTest = getTestRunner(type);

      runTest(
        "should read file content with file_read tool",
        async () => {
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
            const branchName = generateBranchName("read-test");
            const runtimeConfig = getRuntimeConfig(branchName);
            const { workspaceId, cleanup } = await createWorkspaceWithInit(
              env,
              tempGitRepo,
              branchName,
              runtimeConfig,
              true, // waitForInit
              type === "ssh"
            );

            try {
              // Ask AI to create a test file
              const testFileName = "test_read.txt";
              const streamTimeout =
                type === "ssh" ? STREAM_TIMEOUT_SSH_MS : STREAM_TIMEOUT_LOCAL_MS;
              const createEvents = await sendMessageAndWait(
                env,
                workspaceId,
                `Create a file called ${testFileName} with the content: "Hello from mux file tools!"`,
                HAIKU_MODEL,
                FILE_TOOLS_ONLY,
                streamTimeout
              );

              // Verify file was created successfully
              const createStreamEnd = createEvents.find(
                (e) => "type" in e && e.type === "stream-end"
              );
              expect(createStreamEnd).toBeDefined();
              expect(streamEndError(createStreamEnd)).toBeUndefined();

              // Now ask AI to read the file (explicitly request file_read tool)
              const readEvents = await sendMessageAndWait(
                env,
                workspaceId,
                `Use the file_read tool to read ${testFileName} and tell me what it contains.`,
                HAIKU_MODEL,
                FILE_TOOLS_ONLY,
                streamTimeout
              );

              // Verify stream completed successfully
              const streamEnd = readEvents.find((e) => "type" in e && e.type === "stream-end");
              expect(streamEnd).toBeDefined();
              expect(streamEndError(streamEnd)).toBeUndefined();

              // Verify file_read tool was called
              const toolCalls = readEvents.filter(isToolCallStart);
              const fileReadCall = toolCalls.find((e) => e.toolName === "file_read");
              expect(fileReadCall).toBeDefined();

              // Verify response mentions the content
              const responseText = extractTextFromEvents(readEvents);
              expect(responseText.toLowerCase()).toContain("hello");
            } finally {
              await cleanup();
            }
          } finally {
            await cleanupTestEnvironment(env);
            await cleanupTempGitRepo(tempGitRepo);
          }
        },
        type === "ssh" ? TEST_TIMEOUT_SSH_MS : TEST_TIMEOUT_LOCAL_MS
      );

      runTest(
        "should replace text with file_edit_replace_string tool",
        async () => {
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
            const branchName = generateBranchName("replace-test");
            const runtimeConfig = getRuntimeConfig(branchName);
            const { workspaceId, cleanup } = await createWorkspaceWithInit(
              env,
              tempGitRepo,
              branchName,
              runtimeConfig,
              true, // waitForInit
              type === "ssh"
            );

            try {
              // Ask AI to create a test file
              const testFileName = "test_replace.txt";
              const streamTimeout =
                type === "ssh" ? STREAM_TIMEOUT_SSH_MS : STREAM_TIMEOUT_LOCAL_MS;
              const createEvents = await sendMessageAndWait(
                env,
                workspaceId,
                `Create a file called ${testFileName} with the content: "The quick brown fox jumps over the lazy dog."`,
                HAIKU_MODEL,
                FILE_TOOLS_ONLY,
                streamTimeout
              );

              // Verify file was created successfully
              const createStreamEnd = createEvents.find(
                (e) => "type" in e && e.type === "stream-end"
              );
              expect(createStreamEnd).toBeDefined();
              expect(streamEndError(createStreamEnd)).toBeUndefined();

              // Ask AI to replace text (explicitly request file_edit_replace_string tool)
              const replaceEvents = await sendMessageAndWait(
                env,
                workspaceId,
                `Use the file_edit_replace_string tool to replace "brown fox" with "red panda" in ${testFileName}.`,
                HAIKU_MODEL,
                FILE_TOOLS_ONLY,
                streamTimeout
              );

              // Verify stream completed successfully
              const streamEnd = replaceEvents.find((e) => "type" in e && e.type === "stream-end");
              expect(streamEnd).toBeDefined();
              expect(streamEndError(streamEnd)).toBeUndefined();

              // Verify file_edit_replace_string tool was called
              const toolCalls = replaceEvents.filter(isToolCallStart);
              const replaceCall = toolCalls.find((e) => e.toolName === "file_edit_replace_string");
              expect(replaceCall).toBeDefined();

              // Verify the replacement was successful (check for diff or success message)
              const responseText = extractTextFromEvents(replaceEvents);
              expect(
                responseText.toLowerCase().includes("replace") ||
                  responseText.toLowerCase().includes("changed") ||
                  responseText.toLowerCase().includes("updated")
              ).toBe(true);
            } finally {
              await cleanup();
            }
          } finally {
            await cleanupTestEnvironment(env);
            await cleanupTempGitRepo(tempGitRepo);
          }
        },
        type === "ssh" ? TEST_TIMEOUT_SSH_MS : TEST_TIMEOUT_LOCAL_MS
      );

      runTest(
        "should insert text with file_edit_insert tool",
        async () => {
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
            const branchName = generateBranchName("insert-test");
            const runtimeConfig = getRuntimeConfig(branchName);
            const { workspaceId, cleanup } = await createWorkspaceWithInit(
              env,
              tempGitRepo,
              branchName,
              runtimeConfig,
              true, // waitForInit
              type === "ssh"
            );

            try {
              // Ask AI to create a test file
              const testFileName = "test_insert.txt";
              const streamTimeout =
                type === "ssh" ? STREAM_TIMEOUT_SSH_MS : STREAM_TIMEOUT_LOCAL_MS;
              const createEvents = await sendMessageAndWait(
                env,
                workspaceId,
                `Create a file called ${testFileName} with two lines: "Line 1" and "Line 3".`,
                HAIKU_MODEL,
                FILE_TOOLS_ONLY,
                streamTimeout
              );

              // Verify file was created successfully
              const createStreamEnd = createEvents.find(
                (e) => "type" in e && e.type === "stream-end"
              );
              expect(createStreamEnd).toBeDefined();
              expect(streamEndError(createStreamEnd)).toBeUndefined();

              // Ask AI to insert text (explicitly request file_edit tool usage)
              const insertEvents = await sendMessageAndWait(
                env,
                workspaceId,
                `Use the file_edit_insert (preferred) or file_edit_replace_string tool to insert "Line 2" between Line 1 and Line 3 in ${testFileName}.`,
                HAIKU_MODEL,
                FILE_TOOLS_ONLY,
                streamTimeout
              );

              // Verify stream completed successfully
              const streamEnd = insertEvents.find((e) => "type" in e && e.type === "stream-end");
              expect(streamEnd).toBeDefined();
              expect(streamEndError(streamEnd)).toBeUndefined();

              // Verify file_edit_insert (or fallback file_edit_replace_string) tool was called
              const toolCalls = insertEvents.filter(isToolCallStart);
              const editCall = toolCalls.find(
                (e) =>
                  e.toolName === "file_edit_insert" || e.toolName === "file_edit_replace_string"
              );
              expect(editCall).toBeDefined();

              // Verify the insertion was successful
              const responseText = extractTextFromEvents(insertEvents);
              expect(
                responseText.toLowerCase().includes("insert") ||
                  responseText.toLowerCase().includes("add") ||
                  responseText.toLowerCase().includes("updated")
              ).toBe(true);
            } finally {
              await cleanup();
            }
          } finally {
            await cleanupTestEnvironment(env);
            await cleanupTempGitRepo(tempGitRepo);
          }
        },
        type === "ssh" ? TEST_TIMEOUT_SSH_MS : TEST_TIMEOUT_LOCAL_MS
      );

      runTest(
        "should handle relative paths correctly when editing files",
        async () => {
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
            const branchName = generateBranchName("relative-path-test");
            const runtimeConfig = getRuntimeConfig(branchName);
            const { workspaceId, cleanup } = await createWorkspaceWithInit(
              env,
              tempGitRepo,
              branchName,
              runtimeConfig,
              true,
              type === "ssh"
            );

            try {
              const streamTimeout =
                type === "ssh" ? STREAM_TIMEOUT_SSH_MS : STREAM_TIMEOUT_LOCAL_MS;

              // Create a file using AI with a relative path
              const relativeTestFile = "subdir/relative_test.txt";
              const createEvents = await sendMessageAndWait(
                env,
                workspaceId,
                `Create a file at path "${relativeTestFile}" with content: "Original content"`,
                HAIKU_MODEL,
                FILE_TOOLS_ONLY,
                streamTimeout
              );

              // Verify file was created successfully
              const createStreamEnd = createEvents.find(
                (e) => "type" in e && e.type === "stream-end"
              );
              expect(createStreamEnd).toBeDefined();
              expect(streamEndError(createStreamEnd)).toBeUndefined();

              // Now edit the file using a relative path
              const editEvents = await sendMessageAndWait(
                env,
                workspaceId,
                `Replace the text in ${relativeTestFile}: change "Original" to "Modified"`,
                HAIKU_MODEL,
                FILE_TOOLS_ONLY,
                streamTimeout
              );

              // Verify edit was successful
              const editStreamEnd = editEvents.find((e) => "type" in e && e.type === "stream-end");
              expect(editStreamEnd).toBeDefined();
              expect(streamEndError(editStreamEnd)).toBeUndefined();

              // Verify file_edit_replace_string tool was called
              const toolCalls = editEvents.filter(isToolCallStart);
              const editCall = toolCalls.find((e) => e.toolName === "file_edit_replace_string");
              expect(editCall).toBeDefined();

              // Read the file to verify the edit was applied
              const readEvents = await sendMessageAndWait(
                env,
                workspaceId,
                `Read the file ${relativeTestFile} and tell me its content`,
                HAIKU_MODEL,
                FILE_TOOLS_ONLY,
                streamTimeout
              );

              const responseText = extractTextFromEvents(readEvents);
              // The file should contain "Modified" not "Original"
              expect(responseText.toLowerCase()).toContain("modified");

              // If this is SSH, the bug would cause the edit to fail because
              // path.resolve() would resolve relative to the LOCAL filesystem
              // instead of the REMOTE filesystem
            } finally {
              await cleanup();
            }
          } finally {
            await cleanupTestEnvironment(env);
            await cleanupTempGitRepo(tempGitRepo);
          }
        },
        type === "ssh" ? TEST_TIMEOUT_SSH_MS : TEST_TIMEOUT_LOCAL_MS
      );
    }
  );
});
