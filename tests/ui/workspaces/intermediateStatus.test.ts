/**
 * UI integration test for the “working but no todo-derived status yet” intermediate state.
 *
 * Expectation: While a send is in pre-stream startup and the agent has not written a todo
 * list yet, the workspace sidebar row should show provider icon + model name + streaming label.
 */

import "../dom";

import { waitFor } from "@testing-library/react";

import { preloadTestModules } from "../../ipc/setup";
import { createStreamCollector } from "../../ipc/streamCollector";
import { createAppHarness } from "../harness";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";

function getWorkspaceElement(container: HTMLElement, workspaceId: string): HTMLElement {
  const el = container.querySelector(
    `[role="button"][data-workspace-id="${workspaceId}"]`
  );
  if (!el) {
    throw new Error(`Workspace element not found for ${workspaceId}`);
  }
  return el;
}

describe("Workspace intermediate status (mock AI router)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("shows model + streaming while send is starting and before todos appear", async () => {
    const app = await createAppHarness({ branchPrefix: "status-intermediate" });

    const collector = createStreamCollector(app.env.orpc, app.workspaceId);
    collector.start();
    await collector.waitForSubscription(5000);

    try {
      // Gate stream-start so we get a stable “starting” window.
      const gatedMessage = "[mock:wait-start] Show intermediate status";
      await app.chat.send(gatedMessage);

      // Ensure we entered the starting window.
      await waitFor(
        () => {
          const state = workspaceStore.getWorkspaceSidebarState(app.workspaceId);
          if (!state.isStarting) {
            throw new Error("Workspace is not in starting state yet");
          }
        },
        { timeout: 10_000 }
      );

      // Assert the sidebar shows the intermediate status (provider/model + mode).
      await waitFor(
        () => {
          const wsEl = getWorkspaceElement(app.view.container, app.workspaceId);
          const modelDisplay = wsEl.querySelector("[data-model-display]");
          if (!modelDisplay) {
            throw new Error("Expected model display in intermediate status");
          }

          const quickArchiveButton = wsEl.querySelector('button[aria-label^="Archive workspace "]');
          if (quickArchiveButton) {
            throw new Error(
              "Quick archive button should stay hidden while the workspace is starting"
            );
          }

          const text = wsEl.textContent ?? "";
          expect(text.toLowerCase()).toContain("streaming");
          expect(text.toLowerCase()).not.toContain("starting");
        },
        { timeout: 10_000 }
      );

      // Stream-start should not have fired yet (gate is still held).
      const sawStreamStartEarly = collector
        .getEvents()
        .some((event) => "type" in event && event.type === "stream-start");
      expect(sawStreamStartEarly).toBe(false);

      // Release the gate and let the stream run.
      app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);

      const streamStart = await collector.waitForEvent("stream-start", 10_000);
      expect(streamStart).not.toBeNull();

      const streamEnd = await collector.waitForEvent("stream-end", 30_000);
      expect(streamEnd).not.toBeNull();

      // After stream completion, the intermediate status row should disappear.
      await waitFor(
        () => {
          const wsEl = getWorkspaceElement(app.view.container, app.workspaceId);
          const modelDisplay = wsEl.querySelector("[data-model-display]");
          if (modelDisplay) {
            throw new Error("Expected intermediate status to disappear after stream end");
          }
        },
        { timeout: 10_000 }
      );
    } finally {
      collector.stop();
      await app.dispose();
    }
  }, 60_000);
});
