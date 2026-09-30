/**
 * Integration tests for stream interruption UI behavior.
 *
 * Tests verify that:
 * - User-initiated interrupts (Ctrl+C/Escape) do NOT show warning RetryBarrier
 * - Transcript hydration suppresses RetryBarrier while preserving cached transcript rows
 *
 * Note: The error-case UI behavior (showing RetryBarrier for network errors) is covered
 * by unit tests in retryEligibility.test.ts. Testing it in UI integration tests is
 * complex due to timing issues with the mock AI router error handling.
 */

import "../dom";

// App-level UI tests can hit loader shells first, so stub Lottie before importing the
// harness to keep happy-dom from tripping over lottie-web's canvas bootstrap.
jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));
import { waitFor } from "@testing-library/react";

import { preloadTestModules } from "../../ipc/setup";
import { createStreamCollector } from "../../ipc/streamCollector";
import { createAppHarness } from "../harness";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";

describe("Stream Interrupt UI (mock AI router)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("user-initiated interrupt hides RetryBarrier warning", async () => {
    const app = await createAppHarness({ branchPrefix: "stream-interrupt" });

    // Create a stream collector for explicit synchronization with backend events
    const collector = createStreamCollector(app.env.orpc, app.workspaceId);
    collector.start();
    await collector.waitForSubscription(5000);

    try {
      // Send a message to start streaming
      // The mock router will respond with "Mock response: <message>"
      await app.chat.send("Test message for interrupt");

      // Wait for the first stream to complete using explicit event synchronization
      const streamEnd = await collector.waitForEvent("stream-end", 30_000);
      expect(streamEnd).not.toBeNull();

      // Verify response appeared in UI
      await app.chat.expectTranscriptContains("Mock response:", 5_000);

      // Now send another message to trigger a new stream, then interrupt it
      // This creates a partial message state with lastAbortReason="user"
      const interruptMessage = "Message to interrupt";

      // Start the message but don't wait for completion
      const sendPromise = app.chat.send(interruptMessage);

      // Wait for stream-start event (explicit synchronization instead of setTimeout)
      const streamStart = await collector.waitForEventN("stream-start", 2, 10_000);
      expect(streamStart).not.toBeNull();

      // Interrupt the stream (simulating user pressing Escape)
      // This should set lastAbortReason to "user"
      await app.env.orpc.workspace.interruptStream({
        workspaceId: app.workspaceId,
      });

      // Wait for stream-abort event (explicit synchronization instead of setTimeout)
      const streamAbort = await collector.waitForEvent("stream-abort", 5_000);
      expect(streamAbort).not.toBeNull();

      // Wait for the send to complete (it will succeed but stream was interrupted)
      await sendPromise.catch(() => {
        // Expected - message send was interrupted
      });

      // Verify: The warning RetryBarrier should NOT be visible
      // RetryBarrier shows "Stream interrupted" text with a Retry button
      // For user-initiated interrupts, we should NOT see "Stream interrupted" (which is from RetryBarrier)
      await waitFor(
        () => {
          const text = app.view.container.textContent ?? "";
          // RetryBarrier specifically shows "Stream interrupted" (with capital S)
          expect(text).not.toContain("Stream interrupted");
        },
        { timeout: 5_000 }
      );

      // Also verify no Retry button is present (RetryBarrier shows a Retry button)
      const buttons = Array.from(app.view.container.querySelectorAll("button"));
      const retryButton = buttons.find((btn) => btn.textContent?.includes("Retry"));
      expect(retryButton).toBeUndefined();

      // Simulate workspace-switch catch-up hydration while interrupted history exists.
      const storeRaw = useWorkspaceStoreRaw();
      const transientState = (
        storeRaw as unknown as {
          chatTransientState: Map<string, { caughtUp: boolean; isHydratingTranscript: boolean }>;
        }
      ).chatTransientState.get(app.workspaceId);
      expect(transientState).toBeDefined();

      transientState!.caughtUp = false;
      transientState!.isHydratingTranscript = true;
      storeRaw.bumpState(app.workspaceId);

      await waitFor(
        () => {
          const placeholder = app.view.container.querySelector(
            '[data-testid="transcript-hydration-placeholder"]'
          );
          expect(placeholder).toBeNull();

          const text = app.view.container.textContent ?? "";
          expect(text).toContain("Mock response:");
          expect(text).not.toContain("No Messages Yet");
          expect(text).not.toContain("Stream interrupted");
        },
        { timeout: 5_000 }
      );

      const buttonsDuringHydration = Array.from(app.view.container.querySelectorAll("button"));
      const hydrationRetryButton = buttonsDuringHydration.find((btn) =>
        btn.textContent?.includes("Retry")
      );
      expect(hydrationRetryButton).toBeUndefined();
    } finally {
      collector.stop();
      await app.dispose();
    }
  }, 60_000);
});
