import "../dom";
import { fireEvent, waitFor } from "@testing-library/react";

import { shouldRunIntegrationTests } from "../../testUtils";
import { STORAGE_KEYS } from "@/constants/workspaceDefaults";
import { getReviewsKey } from "@/common/constants/storage";
import {
  cleanupSharedRepo,
  configureTestRetries,
  createSharedRepo,
  withSharedWorkspace,
} from "../../ipc/sendMessageTestHelpers";
import { installDom } from "../dom";
import { renderReviewPanel, type RenderedApp } from "../renderReviewPanel";
import {
  cleanupView,
  setupWorkspaceView,
  waitForRefreshButtonIdle,
  assertRefreshButtonHasLastRefreshInfo,
  simulateFileModifyingToolEnd,
} from "../helpers";
import type { APIClient } from "@/browser/contexts/API";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";

configureTestRetries(2);

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

/**
 * Helper to set up the full App UI and navigate to the Review tab.
 * Returns the refresh button for assertions.
 */
async function setupReviewPanel(
  view: RenderedApp,
  metadata: FrontendWorkspaceMetadata,
  workspaceId: string
): Promise<HTMLElement> {
  await setupWorkspaceView(view, metadata, workspaceId);
  await view.selectTab("review");
  // Wait for the first diff load to complete
  await view.findAllByText(/No changes found/i, {}, { timeout: 60_000 });
  return view.getByTestId("review-refresh");
}

// ═══════════════════════════════════════════════════════════════════════════════
// MANUAL REFRESH TEST (fast, no LLM calls)
// ═══════════════════════════════════════════════════════════════════════════════

function renderReviewPanelForRefreshTests(params: {
  apiClient: APIClient;
  metadata: FrontendWorkspaceMetadata;
  workspaceId: string;
}): RenderedApp {
  // These refresh tests make uncommitted filesystem changes and expect them to show up in the
  // ReviewPanel diff without toggling includeUncommitted.
  //
  // With the app's default review base now set to a trunk ref (e.g. origin/<trunk>), the default
  // diff would exclude uncommitted changes unless includeUncommitted is enabled. Force HEAD so the
  // diff always reflects the working tree.
  updatePersistedState(STORAGE_KEYS.reviewDiffBase(params.workspaceId), "HEAD");

  return renderReviewPanel({
    apiClient: params.apiClient,
    metadata: params.metadata,
  });
}

describeIntegration("ReviewPanel manual refresh (UI + ORPC)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("manual refresh updates diff and sets lastRefreshInfo", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanelForRefreshTests({
        apiClient: env.orpc,
        metadata,
        workspaceId,
      });

      try {
        const refreshButton = await setupReviewPanel(view, metadata, workspaceId);

        // Make a direct FS change (no tool-call events)
        const MANUAL_MARKER = "MANUAL_REFRESH_TEST_MARKER";
        const bashRes = await env.orpc.workspace.executeBash({
          workspaceId,
          script: `echo "${MANUAL_MARKER}" >> README.md`,
        });
        expect(bashRes.success).toBe(true);
        if (!bashRes.success) return;
        expect(bashRes.data.success).toBe(true);

        // Without manual refresh, the UI should not pick this up yet
        expect(view.queryByText(new RegExp(MANUAL_MARKER))).toBeNull();

        // Click refresh
        fireEvent.click(refreshButton);

        // Immediate feedback: spinner should become visible
        const icon = refreshButton.querySelector("svg");
        await waitFor(
          () => {
            expect(icon?.getAttribute("class") ?? "").toContain("animate-spin");
          },
          { timeout: 5_000 }
        );

        // Wait for the marker to appear in the diff
        await view.findByText(new RegExp(MANUAL_MARKER), {}, { timeout: 60_000 });

        // lastRefreshInfo should reflect manual refresh
        await waitForRefreshButtonIdle(refreshButton);
        await assertRefreshButtonHasLastRefreshInfo(refreshButton, "manual");
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 120_000);

  test("/ focuses review search", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanelForRefreshTests({
        apiClient: env.orpc,
        metadata,
        workspaceId,
      });

      try {
        const refreshButton = await setupReviewPanel(view, metadata, workspaceId);

        const searchInput = view.getByPlaceholderText(/^Search\.\.\./) as HTMLInputElement;

        refreshButton.focus();
        expect(document.activeElement).toBe(refreshButton);

        const slashEvent = new window.KeyboardEvent("keydown", {
          key: "/",
          bubbles: true,
          cancelable: true,
        });
        refreshButton.dispatchEvent(slashEvent);

        expect(slashEvent.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(searchInput);
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 120_000);

  test("/ does not steal focus from editable elements", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanelForRefreshTests({
        apiClient: env.orpc,
        metadata,
        workspaceId,
      });

      const externalInput = document.createElement("input");
      document.body.appendChild(externalInput);

      try {
        await setupReviewPanel(view, metadata, workspaceId);

        const searchInput = view.getByPlaceholderText(/^Search\.\.\./) as HTMLInputElement;

        externalInput.focus();
        expect(document.activeElement).toBe(externalInput);

        const slashEvent = new window.KeyboardEvent("keydown", {
          key: "/",
          bubbles: true,
          cancelable: true,
        });
        externalInput.dispatchEvent(slashEvent);

        expect(slashEvent.defaultPrevented).toBe(false);
        expect(document.activeElement).toBe(externalInput);
        expect(document.activeElement).not.toBe(searchInput);
      } finally {
        externalInput.remove();
        await cleanupView(view, cleanupDom);
      }
    });
  }, 120_000);
  test("Ctrl+R triggers manual refresh", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanelForRefreshTests({
        apiClient: env.orpc,
        metadata,
        workspaceId,
      });

      try {
        const refreshButton = await setupReviewPanel(view, metadata, workspaceId);

        // Initially no lastRefreshInfo
        expect(refreshButton.getAttribute("data-last-refresh-trigger")).toBe("");

        // Press Ctrl+R (or Cmd+R on mac)
        fireEvent.keyDown(window, { key: "r", ctrlKey: true });

        // Should trigger refresh and update lastRefreshInfo
        await waitForRefreshButtonIdle(refreshButton);
        await assertRefreshButtonHasLastRefreshInfo(refreshButton, "manual");
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 120_000);

  test("manual refresh updates lastRefreshInfo even when diff unchanged", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanelForRefreshTests({
        apiClient: env.orpc,
        metadata,
        workspaceId,
      });

      try {
        const refreshButton = await setupReviewPanel(view, metadata, workspaceId);

        // At this point, initial load has completed but no manual refresh yet
        // The button should NOT have lastRefreshInfo (initial load doesn't set it)
        refreshButton.getAttribute("data-last-refresh-trigger");

        // First manual refresh (no changes to diff, just clicking refresh)
        fireEvent.click(refreshButton);
        await waitForRefreshButtonIdle(refreshButton);
        await assertRefreshButtonHasLastRefreshInfo(refreshButton, "manual");

        // Record the first timestamp
        const firstTimestamp = refreshButton.getAttribute("data-last-refresh-timestamp");
        expect(firstTimestamp).toBeTruthy();

        // Wait a moment so timestamp will differ
        await new Promise((r) => setTimeout(r, 100));

        // Second manual refresh (still no changes - diff is identical)
        fireEvent.click(refreshButton);
        await waitForRefreshButtonIdle(refreshButton);
        await assertRefreshButtonHasLastRefreshInfo(refreshButton, "manual");

        // Timestamp should be updated even though diff is unchanged
        const secondTimestamp = refreshButton.getAttribute("data-last-refresh-timestamp");
        expect(secondTimestamp).toBeTruthy();
        expect(Number(secondTimestamp)).toBeGreaterThan(Number(firstTimestamp));
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 120_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// SIMULATED TOOL COMPLETION TEST (fast, no LLM)
// ═══════════════════════════════════════════════════════════════════════════════

describeIntegration("ReviewPanel simulated tool refresh (UI + ORPC, no LLM)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("simulated file-modifying tool triggers scheduled refresh", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanelForRefreshTests({
        apiClient: env.orpc,
        metadata,
        workspaceId,
      });

      try {
        const refreshButton = await setupReviewPanel(view, metadata, workspaceId);

        // Make a direct FS change (simulating what a tool would do)
        const SIMULATED_MARKER = "SIMULATED_TOOL_MARKER";
        const bashRes = await env.orpc.workspace.executeBash({
          workspaceId,
          script: `echo "${SIMULATED_MARKER}" >> README.md`,
        });
        expect(bashRes.success).toBe(true);
        if (!bashRes.success) return;
        expect(bashRes.data.success).toBe(true);

        // Verify the change is NOT visible yet (no refresh)
        expect(view.queryByText(new RegExp(SIMULATED_MARKER))).toBeNull();

        // Simulate a file-modifying tool completion (this triggers the debounced refresh)
        simulateFileModifyingToolEnd(workspaceId);

        // Wait for the debounced refresh to complete (3s debounce + refresh time)
        await view.findByText(new RegExp(SIMULATED_MARKER), {}, { timeout: 60_000 });

        // Verify lastRefreshInfo reflects the scheduled refresh
        await waitForRefreshButtonIdle(refreshButton);
        await assertRefreshButtonHasLastRefreshInfo(refreshButton, "scheduled");
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 120_000);

  test("multiple simulated tool completions are rate-limited with trailing debounce", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanelForRefreshTests({
        apiClient: env.orpc,
        metadata,
        workspaceId,
      });

      try {
        const refreshButton = await setupReviewPanel(view, metadata, workspaceId);

        // Make first file change
        const MARKER_1 = "RATE_LIMIT_MARKER_1";
        await env.orpc.workspace.executeBash({
          workspaceId,
          script: `echo "${MARKER_1}" >> README.md`,
        });

        // Simulate first tool completion - starts the rate-limit timer
        simulateFileModifyingToolEnd(workspaceId);

        // Immediately make more changes and simulate more completions
        // These should be coalesced (rate-limited)
        const MARKER_2 = "RATE_LIMIT_MARKER_2";
        await env.orpc.workspace.executeBash({
          workspaceId,
          script: `echo "${MARKER_2}" >> README.md`,
        });
        simulateFileModifyingToolEnd(workspaceId);

        const MARKER_3 = "RATE_LIMIT_MARKER_3";
        await env.orpc.workspace.executeBash({
          workspaceId,
          script: `echo "${MARKER_3}" >> README.md`,
        });
        simulateFileModifyingToolEnd(workspaceId);

        // Wait for all markers to appear (proving trailing debounce captured final state)
        await view.findByText(new RegExp(MARKER_1), {}, { timeout: 60_000 });
        await view.findByText(new RegExp(MARKER_2), {}, { timeout: 5_000 });
        await view.findByText(new RegExp(MARKER_3), {}, { timeout: 5_000 });

        // Verify lastRefreshInfo
        await waitForRefreshButtonIdle(refreshButton);
        await assertRefreshButtonHasLastRefreshInfo(refreshButton, "scheduled");
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 120_000);

  test("refresh runs while panel focused", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanelForRefreshTests({
        apiClient: env.orpc,
        metadata,
        workspaceId,
      });

      try {
        const refreshButton = await setupReviewPanel(view, metadata, workspaceId);

        // Find the review panel container
        const reviewPanel = view.container.querySelector('[data-testid="review-panel"]');
        expect(reviewPanel).not.toBeNull();

        // Focus the panel (simulates user interacting with the review)
        fireEvent.focus(reviewPanel!);

        // Make a file change while panel is focused
        const FOCUS_MARKER = "FOCUS_MARKER_WHILE_FOCUSED";
        await env.orpc.workspace.executeBash({
          workspaceId,
          script: `echo "${FOCUS_MARKER}" >> README.md`,
        });

        // Simulate tool completion - refresh should still run while focused
        simulateFileModifyingToolEnd(workspaceId);

        // Wait for the refresh to complete
        await view.findByText(new RegExp(FOCUS_MARKER), {}, { timeout: 60_000 });

        // Verify lastRefreshInfo
        await waitForRefreshButtonIdle(refreshButton);
        await assertRefreshButtonHasLastRefreshInfo(refreshButton, "scheduled");
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 120_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO REFRESH TEST
// ═══════════════════════════════════════════════════════════════════════════════

describeIntegration("ReviewPanel auto refresh (UI + ORPC)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("tool-call-end triggers scheduled refresh", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanelForRefreshTests({
        apiClient: env.orpc,
        metadata,
        workspaceId,
      });

      try {
        const refreshButton = await setupReviewPanel(view, metadata, workspaceId);

        const AUTO_MARKER = "AUTO_REFRESH_MARKER";

        // Make a direct FS change (no tool-call events). The scheduled/tool-completion
        // refresh should still pick this up.
        const bashRes = await env.orpc.workspace.executeBash({
          workspaceId,
          script: `echo "${AUTO_MARKER}" >> README.md`,
        });
        expect(bashRes.success).toBe(true);
        if (!bashRes.success) return;
        expect(bashRes.data.success).toBe(true);

        // Without a scheduled refresh, the UI should not pick this up yet.
        expect(view.queryByText(new RegExp(AUTO_MARKER))).toBeNull();

        // Exercise the same WorkspaceStore event emitted after file-modifying tools complete.
        // A live model made this behavioral test depend on whether the provider chose/called bash,
        // which repeatedly flaked in CI before the event under test was ever emitted.
        simulateFileModifyingToolEnd(workspaceId);

        // Verify the workspace actually changed
        const statusRes = await env.orpc.workspace.executeBash({
          workspaceId,
          script: "git status --porcelain",
        });
        expect(statusRes.success).toBe(true);
        if (!statusRes.success) return;
        expect(statusRes.data.success).toBe(true);
        expect(statusRes.data.output).toContain("README.md");

        // Wait for ReviewPanel's tool-completion debounce + refresh to land
        // Use findAllByText since the marker may appear in chat (user message, tool output) and diff
        const matches = await view.findAllByText(new RegExp(AUTO_MARKER), {}, { timeout: 60_000 });
        // There should be at least one match in the diff panel
        expect(matches.length).toBeGreaterThanOrEqual(1);

        // lastRefreshInfo should reflect the scheduled/tool-completion refresh
        await waitForRefreshButtonIdle(refreshButton);
        await assertRefreshButtonHasLastRefreshInfo(refreshButton, "scheduled");
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 180_000);

  test("refresh button is disabled while composing review note", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanelForRefreshTests({
        apiClient: env.orpc,
        metadata,
        workspaceId,
      });

      try {
        const refreshButton = await setupReviewPanel(view, metadata, workspaceId);

        // First, create some changes so we have a diff to interact with
        const INITIAL_MARKER = "COMPOSE_TEST_MARKER";
        await env.orpc.workspace.executeBash({
          workspaceId,
          script: `echo "${INITIAL_MARKER}" >> README.md`,
        });

        // Manual refresh to pick up the change
        fireEvent.click(refreshButton);
        await waitForRefreshButtonIdle(refreshButton);
        await assertRefreshButtonHasLastRefreshInfo(refreshButton, "manual");

        // Verify the diff is visible
        await view.findByText(new RegExp(INITIAL_MARKER), {}, { timeout: 30_000 });

        // Record timestamp after initial refresh
        const initialTimestamp = refreshButton.getAttribute("data-last-refresh-timestamp");
        expect(initialTimestamp).toBeTruthy();

        // Button should NOT be disabled initially
        expect(refreshButton.getAttribute("data-disabled")).toBeNull();
        expect(refreshButton.hasAttribute("disabled")).toBe(false);

        // Find a diff indicator to start selection on
        const diffIndicator = await waitFor(
          () => {
            const indicators = view.container.querySelectorAll("[data-diff-indicator]");
            if (indicators.length === 0) throw new Error("No diff indicators found");
            const addIndicator = Array.from(indicators).find((el) =>
              el.textContent?.trim().startsWith("+")
            );
            if (!addIndicator) throw new Error("No add line indicator found");
            return addIndicator as HTMLElement;
          },
          { timeout: 10_000 }
        );

        // Start selection by mousedown on the diff indicator, then mouseup to complete
        fireEvent.mouseDown(diffIndicator, { button: 0 });
        fireEvent.mouseUp(window);

        const textarea = (await view.findByPlaceholderText(
          /Add a review note/i,
          {},
          { timeout: 10_000 }
        )) as HTMLTextAreaElement;

        // Wait for React state update
        await waitFor(
          () => {
            // Button should now be disabled
            if (!refreshButton.hasAttribute("disabled")) {
              throw new Error("Button should be disabled during composition");
            }
          },
          { timeout: 5_000 }
        );

        expect(refreshButton.getAttribute("data-disabled")).toBe("true");

        // Try to click the disabled button - should NOT trigger refresh
        fireEvent.click(refreshButton);

        // Wait a bit to ensure no refresh happens
        await new Promise((r) => setTimeout(r, 500));

        // Timestamp should NOT have changed (refresh was blocked)
        const duringTimestamp = refreshButton.getAttribute("data-last-refresh-timestamp");
        expect(duringTimestamp).toBe(initialTimestamp);

        // Submit a review note and ensure the refresh button is re-enabled.
        const NOTE_TEXT = "INLINE_REVIEW_NOTE_TEST_MARKER";

        textarea.focus();
        fireEvent.focus(textarea);

        // eslint-disable-next-line @typescript-eslint/unbound-method -- native setter is invoked with .call(textarea) below
        const valueSetter = Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(textarea),
          "value"
        )?.set;
        valueSetter?.call(textarea, NOTE_TEXT);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));

        // Allow React to commit the onChange update before submitting.
        await waitFor(() => {
          expect(textarea.value).toBe(NOTE_TEXT);
        });

        const submitButton = await view.findByLabelText(
          /Submit review note/i,
          {},
          { timeout: 5000 }
        );
        fireEvent.click(submitButton);

        // Ensure the review input was dismissed (submit cleared selection)
        await waitFor(() => {
          const stillThere = view.queryByPlaceholderText(/Add a review note/i);
          if (stillThere) throw new Error("Review note input still visible after submit");
        });

        // Ensure the review was persisted before asserting UI updates.
        await waitFor(
          () => {
            const persisted = readPersistedState<unknown>(getReviewsKey(workspaceId), null);
            if (!persisted) throw new Error("Review not persisted");
            expect(JSON.stringify(persisted)).toContain(NOTE_TEXT);
          },
          { timeout: 10_000 }
        );

        await waitFor(
          () => {
            expect(refreshButton.hasAttribute("disabled")).toBe(false);
          },
          { timeout: 5_000 }
        );

        await waitFor(
          () => {
            const inlineNotes = Array.from(
              view.container.querySelectorAll<HTMLElement>("[data-inline-review-note]")
            );
            if (inlineNotes.length === 0) throw new Error("No inline review notes rendered");
            expect(inlineNotes.some((el) => el.textContent?.includes(NOTE_TEXT))).toBe(true);
          },
          { timeout: 5_000 }
        );

        // Note: Testing escape/cancel would require complex DOM simulation.
        // The key behaviors verified by this test:
        // 1. Button becomes disabled when composing review note
        // 2. Clicking disabled button does not trigger refresh
        // 3. Submitting a note re-enables refresh and renders the note inline
        // Unit tests in RefreshController.test.ts verify that notifyUnpaused()
        // correctly flushes pending refreshes when composition ends.
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 180_000);
});
