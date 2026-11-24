/**
 * interruptStream "starting..." integration tests.
 *
 * Regression test: interruptStream() should work even before StreamManager emits
 * stream-start (e.g., while AIService is blocked on initStateManager.waitForInit).
 */

import {
  shouldRunIntegrationTests,
  validateApiKeys,
  createTestEnvironment,
  cleanupTestEnvironment,
  setupProviders,
  getApiKey,
} from "../setup";
import {
  createTempGitRepo,
  cleanupTempGitRepo,
  createWorkspace,
  generateBranchName,
  sendMessageWithModel,
  waitFor,
  HAIKU_MODEL,
} from "../helpers";
import { createStreamCollector } from "../streamCollector";
import { isInitOutput, isMuxMessage } from "@/common/orpc/types";
import * as path from "path";
import * as fs from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

async function addInitHook(repoPath: string, scriptBody: string): Promise<void> {
  const muxDir = path.join(repoPath, ".mux");
  await fs.mkdir(muxDir, { recursive: true });

  const hookPath = path.join(muxDir, "init");
  await fs.writeFile(hookPath, `#!/bin/bash\n${scriptBody}\n`, { mode: 0o755 });

  await execAsync(`git add -A`, { cwd: repoPath });
  await execAsync(`git -c commit.gpgsign=false commit -m "Add init hook"`, { cwd: repoPath });
}

describeIntegration("interruptStream during startup", () => {
  test("should emit stream-abort without stream-start when interrupted before stream-start", async () => {
    const env = await createTestEnvironment();
    const repoPath = await createTempGitRepo();

    // Give the init hook enough time to keep init in-progress while we interrupt.
    await addInitHook(
      repoPath,
      ['echo "Starting init hook..."', "sleep 6", 'echo "Init hook done"', "exit 0"].join("\n")
    );

    let workspaceId: string | null = null;
    let collector: ReturnType<typeof createStreamCollector> | null = null;

    try {
      await setupProviders(env, {
        anthropic: {
          apiKey: getApiKey("ANTHROPIC_API_KEY"),
        },
      });

      const branchName = generateBranchName("test-starting-interrupt");
      const result = await createWorkspace(env, repoPath, branchName);
      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(result.error);
      }
      workspaceId = result.metadata.id;

      // Start collector now that we have a workspaceId.
      collector = createStreamCollector(env.orpc, workspaceId);
      collector.start();
      await collector.waitForSubscription(5000);

      const activeCollector = collector;

      // Ensure the init hook is actually running so sendMessage() will block on waitForInit.
      const sawInitStart = await waitFor(() => {
        return activeCollector
          .getEvents()
          .some((e) => isInitOutput(e) && e.line.includes("Starting init hook..."));
      }, 5000);
      expect(sawInitStart).toBe(true);

      // Start sending a message (will block on init hook).
      const sendPromise = sendMessageWithModel(
        env,
        workspaceId,
        "Say 'hello' and nothing else",
        HAIKU_MODEL
      );

      // Ensure sendMessage() is actually in-flight (should be blocked by init hook).
      const resolvedEarly = await Promise.race([
        sendPromise.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
      ]);
      expect(resolvedEarly).toBe(false);

      // Wait until we observe the user message being persisted/emitted.
      const sawUserMessage = await waitFor(() => {
        return activeCollector.getEvents().some((e) => isMuxMessage(e) && e.role === "user");
      }, 5000);
      expect(sawUserMessage).toBe(true);

      // We should still be in pre-stream-start startup.
      expect(activeCollector.getEvents().some((e) => e.type === "stream-start")).toBe(false);

      // Give sendMessage() a moment to enter AIService.streamMessage and register the pending start.
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Interrupt while still in "starting...".
      const interruptResult = await env.orpc.workspace.interruptStream({ workspaceId });
      expect(interruptResult.success).toBe(true);

      const abortEvent = await activeCollector.waitForEvent("stream-abort", 5000);
      expect(abortEvent).not.toBeNull();
      expect(abortEvent?.type).toBe("stream-abort");
      if (abortEvent?.type === "stream-abort") {
        // In the normal pre-stream path, AIService emits a synthetic "starting-*" message id.
        // Rarely, startup can settle before interrupt races through and StreamManager emits an
        // abort with an empty id instead. Accept both while still asserting no stream-start.
        if (abortEvent.messageId.length > 0) {
          expect(abortEvent.messageId).toMatch(/^starting-/);
        }
      }

      const sendResult = await sendPromise;
      expect(sendResult.success).toBe(true);

      // Wait for init to complete so teardown doesn't race the init hook process.
      const initEndEvent = await activeCollector.waitForEvent("init-end", 10000);
      expect(initEndEvent).not.toBeNull();

      // Ensure stream-start never happened.
      const streamStartEvent = await activeCollector.waitForEvent("stream-start", 500);
      expect(streamStartEvent).toBeNull();
    } finally {
      collector?.stop();
      if (workspaceId) {
        await env.orpc.workspace.remove({ workspaceId });
      }
      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(repoPath);
    }
  }, 25000);
});
