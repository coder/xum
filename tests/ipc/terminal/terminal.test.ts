import { shouldRunIntegrationTests, createTestEnvironment, cleanupTestEnvironment } from "../setup";
import {
  createTempGitRepo,
  cleanupTempGitRepo,
  createWorkspace,
  resolveOrpcClient,
} from "../helpers";
import type { WorkspaceMetadata } from "../../../src/common/types/workspace";

type WorkspaceCreationResult = Awaited<ReturnType<typeof createWorkspace>>;

function expectWorkspaceCreationSuccess(result: WorkspaceCreationResult): WorkspaceMetadata {
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error(`Expected workspace creation to succeed, but it failed: ${result.error}`);
  }
  return result.metadata;
}

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("terminal PTY", () => {
  test.concurrent(
    "should create terminal session, send command, receive output, and close",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        // Create a workspace (uses worktree runtime by default)
        const createResult = await createWorkspace(env, tempGitRepo, "test-terminal");
        const metadata = expectWorkspaceCreationSuccess(createResult);
        const workspaceId = metadata.id;
        const client = resolveOrpcClient(env);

        // Create terminal session
        const session = await client.terminal.create({
          workspaceId,
          cols: 80,
          rows: 24,
        });

        expect(session.sessionId).toBeTruthy();
        expect(session.workspaceId).toBe(workspaceId);

        // Collect output
        const outputChunks: string[] = [];
        const outputPromise = (async () => {
          const iterator = await client.terminal.onOutput({ sessionId: session.sessionId });
          for await (const chunk of iterator) {
            outputChunks.push(chunk);
            // Stop collecting after we see our expected output
            const fullOutput = outputChunks.join("");
            if (fullOutput.includes("TERMINAL_TEST_SUCCESS")) {
              break;
            }
          }
        })();

        // Give the terminal time to initialize and show prompt
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Send a command that echoes a unique marker
        await client.terminal.sendInput({
          sessionId: session.sessionId,
          data: "echo TERMINAL_TEST_SUCCESS\n",
        });

        // Wait for output with timeout
        const timeoutPromise = new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error("Timeout waiting for terminal output")), 10000);
        });

        await Promise.race([outputPromise, timeoutPromise]);

        // Verify we received the expected output
        const fullOutput = outputChunks.join("");
        expect(fullOutput).toContain("TERMINAL_TEST_SUCCESS");

        // Close the terminal session
        await client.terminal.close({ sessionId: session.sessionId });

        // Clean up workspace
        await client.workspace.remove({ workspaceId });
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    20000
  );

  test.concurrent(
    "should handle exit event when terminal closes",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        // Create a workspace
        const createResult = await createWorkspace(env, tempGitRepo, "test-terminal-exit");
        const metadata = expectWorkspaceCreationSuccess(createResult);
        const workspaceId = metadata.id;
        const client = resolveOrpcClient(env);

        // Create terminal session
        const session = await client.terminal.create({
          workspaceId,
          cols: 80,
          rows: 24,
        });

        // Subscribe to exit event
        let exitCode: number | null = null;
        const exitPromise = (async () => {
          const iterator = await client.terminal.onExit({ sessionId: session.sessionId });
          for await (const code of iterator) {
            exitCode = code;
            break;
          }
        })();

        // Give terminal time to initialize
        await new Promise((resolve) => setTimeout(resolve, 300));

        // Send exit command to cleanly close the shell
        await client.terminal.sendInput({
          sessionId: session.sessionId,
          data: "exit 0\n",
        });

        // Wait for exit with timeout
        const timeoutPromise = new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error("Timeout waiting for terminal exit")), 10000);
        });

        await Promise.race([exitPromise, timeoutPromise]);

        // Verify we got an exit code (typically 0 for clean exit)
        expect(exitCode).toBe(0);

        // Clean up workspace
        await client.workspace.remove({ workspaceId });
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    20000
  );

  test.concurrent(
    "should handle terminal resize",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        // Create a workspace
        const createResult = await createWorkspace(env, tempGitRepo, "test-terminal-resize");
        const metadata = expectWorkspaceCreationSuccess(createResult);
        const workspaceId = metadata.id;
        const client = resolveOrpcClient(env);

        // Create terminal session with initial size
        const session = await client.terminal.create({
          workspaceId,
          cols: 80,
          rows: 24,
        });

        // Resize should not throw
        await client.terminal.resize({
          sessionId: session.sessionId,
          cols: 120,
          rows: 40,
        });

        // Verify terminal is still functional after resize
        const outputChunks: string[] = [];
        const outputPromise = (async () => {
          const iterator = await client.terminal.onOutput({ sessionId: session.sessionId });
          for await (const chunk of iterator) {
            outputChunks.push(chunk);
            if (outputChunks.join("").includes("RESIZE_TEST_OK")) {
              break;
            }
          }
        })();

        await new Promise((resolve) => setTimeout(resolve, 300));

        await client.terminal.sendInput({
          sessionId: session.sessionId,
          data: "echo RESIZE_TEST_OK\n",
        });

        const timeoutPromise = new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error("Timeout after resize")), 10000);
        });

        await Promise.race([outputPromise, timeoutPromise]);

        expect(outputChunks.join("")).toContain("RESIZE_TEST_OK");

        // Clean up
        await client.terminal.close({ sessionId: session.sessionId });
        await client.workspace.remove({ workspaceId });
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    20000
  );

  test.concurrent(
    "attach should return screenState first, then live output",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        const createResult = await createWorkspace(env, tempGitRepo, "test-attach");
        const metadata = expectWorkspaceCreationSuccess(createResult);
        const workspaceId = metadata.id;
        const client = resolveOrpcClient(env);

        // Create terminal session
        const session = await client.terminal.create({
          workspaceId,
          cols: 80,
          rows: 24,
        });

        // Give terminal time to initialize
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Use attach endpoint - first message should be screenState
        const messages: { type: "screenState" | "output"; data: string }[] = [];
        const attachPromise = (async () => {
          const iterator = await client.terminal.attach({ sessionId: session.sessionId });
          for await (const msg of iterator) {
            messages.push(msg);
            // Collect until we have screenState + at least one output with our marker
            const fullOutput = messages
              .filter((m) => m.type === "output")
              .map((m) => m.data)
              .join("");
            if (messages.length >= 1 && fullOutput.includes("ATTACH_TEST")) {
              break;
            }
            // Safety limit
            if (messages.length > 50) break;
          }
        })();

        // Small delay to ensure attach has started
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Send command
        await client.terminal.sendInput({
          sessionId: session.sessionId,
          data: "echo ATTACH_TEST\\n",
        });

        const timeoutPromise = new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error("Timeout in attach test")), 10000);
        });

        await Promise.race([attachPromise, timeoutPromise]);

        // First message should always be screenState
        expect(messages.length).toBeGreaterThan(0);
        expect(messages[0].type).toBe("screenState");

        // Should have output messages after screenState
        const outputMessages = messages.filter((m) => m.type === "output");
        expect(outputMessages.length).toBeGreaterThan(0);

        // Output should contain our test marker
        const fullOutput = outputMessages.map((m) => m.data).join("");
        expect(fullOutput).toContain("ATTACH_TEST");

        await client.terminal.close({ sessionId: session.sessionId });
        await client.workspace.remove({ workspaceId });
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    20000
  );

  test.concurrent(
    "attach should preserve output order - no race conditions",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        const createResult = await createWorkspace(env, tempGitRepo, "test-attach-order");
        const metadata = expectWorkspaceCreationSuccess(createResult);
        const workspaceId = metadata.id;
        const client = resolveOrpcClient(env);

        // Create terminal and send numbered output
        const session = await client.terminal.create({
          workspaceId,
          cols: 80,
          rows: 24,
        });

        await new Promise((resolve) => setTimeout(resolve, 500));

        // First, send some commands to populate terminal state
        await client.terminal.sendInput({
          sessionId: session.sessionId,
          data: "echo LINE1\\n",
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
        await client.terminal.sendInput({
          sessionId: session.sessionId,
          data: "echo LINE2\\n",
        });
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Now attach and send more lines - verify order is preserved
        const messages: { type: "screenState" | "output"; data: string }[] = [];
        const attachPromise = (async () => {
          const iterator = await client.terminal.attach({ sessionId: session.sessionId });
          for await (const msg of iterator) {
            messages.push(msg);
            const fullOutput = messages
              .filter((m) => m.type === "output")
              .map((m) => m.data)
              .join("");
            if (fullOutput.includes("LINE4")) {
              break;
            }
            if (messages.length > 100) break;
          }
        })();

        // After attach starts, send more lines
        await new Promise((resolve) => setTimeout(resolve, 100));
        await client.terminal.sendInput({
          sessionId: session.sessionId,
          data: "echo LINE3\\n",
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        await client.terminal.sendInput({
          sessionId: session.sessionId,
          data: "echo LINE4\\n",
        });

        await Promise.race([
          attachPromise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Timeout in order test")), 10000)
          ),
        ]);

        // Screen state should be first
        expect(messages[0].type).toBe("screenState");

        // Screen state should contain LINE1 and LINE2 (from before attach)
        expect(messages[0].data).toContain("LINE1");
        expect(messages[0].data).toContain("LINE2");

        // Output messages should contain LINE3 and LINE4 (sent after attach)
        const outputData = messages
          .filter((m) => m.type === "output")
          .map((m) => m.data)
          .join("");
        expect(outputData).toContain("LINE3");
        expect(outputData).toContain("LINE4");

        // Verify LINE3 comes before LINE4 in output
        const line3Pos = outputData.indexOf("LINE3");
        const line4Pos = outputData.indexOf("LINE4");
        expect(line3Pos).toBeLessThan(line4Pos);

        await client.terminal.close({ sessionId: session.sessionId });
        await client.workspace.remove({ workspaceId });
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    25000
  );

  test.concurrent(
    "reattach via attach should restore terminal state with escape sequences",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        const createResult = await createWorkspace(env, tempGitRepo, "test-reattach");
        const metadata = expectWorkspaceCreationSuccess(createResult);
        const workspaceId = metadata.id;
        const client = resolveOrpcClient(env);

        // Create terminal session
        const session = await client.terminal.create({
          workspaceId,
          cols: 80,
          rows: 24,
        });

        // Wait for shell to initialize and produce output
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Send a command that produces visible output
        const outputChunks: string[] = [];
        const outputPromise = (async () => {
          const iterator = await client.terminal.onOutput({ sessionId: session.sessionId });
          for await (const chunk of iterator) {
            outputChunks.push(chunk);
            if (outputChunks.join("").includes("REATTACH_TEST")) break;
          }
        })();

        await client.terminal.sendInput({
          sessionId: session.sessionId,
          data: "echo REATTACH_TEST\n",
        });

        await Promise.race([
          outputPromise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Timeout waiting for output")), 5000)
          ),
        ]);

        // Now use attach to reattach - simulating what happens on workspace switch
        const attachMessages: { type: "screenState" | "output"; data: string }[] = [];
        const attachPromise = (async () => {
          const iterator = await client.terminal.attach({ sessionId: session.sessionId });
          for await (const msg of iterator) {
            attachMessages.push(msg);
            // Just get the first message (screenState)
            break;
          }
        })();

        await Promise.race([
          attachPromise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Timeout in attach")), 5000)
          ),
        ]);

        // First message should be screenState
        expect(attachMessages[0].type).toBe("screenState");

        // Screen state should contain escape sequences (colors, cursor positioning, etc.)
        const screenState = attachMessages[0].data;
        expect(screenState.length).toBeGreaterThan(0);
        // Should contain escape sequences
        expect(screenState).toContain("\x1b[");

        await client.terminal.close({ sessionId: session.sessionId });
        await client.workspace.remove({ workspaceId });
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    15000
  );

  test.concurrent(
    "listSessions should return active session IDs for a workspace",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        const createResult = await createWorkspace(env, tempGitRepo, "test-list-sessions");
        const metadata = expectWorkspaceCreationSuccess(createResult);
        const workspaceId = metadata.id;
        const client = resolveOrpcClient(env);

        // Initially no sessions
        const initialSessions = await client.terminal.listSessions({ workspaceId });
        expect(initialSessions).toEqual([]);

        // Create a terminal session
        const session = await client.terminal.create({
          workspaceId,
          cols: 80,
          rows: 24,
        });

        // Now should have one session
        const afterCreate = await client.terminal.listSessions({ workspaceId });
        expect(afterCreate).toContain(session.sessionId);
        expect(afterCreate.length).toBe(1);

        // Close session
        await client.terminal.close({ sessionId: session.sessionId });

        // Wait for close to propagate
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Should be empty again
        const afterClose = await client.terminal.listSessions({ workspaceId });
        expect(afterClose).toEqual([]);

        await client.workspace.remove({ workspaceId });
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    15000
  );
});
