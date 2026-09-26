/**
 * UI integration tests for the unread indicator.
 *
 * The unread indicator shows when a workspace has activity the user hasn't seen.
 * Key components:
 * - recencyTimestamp: derived from max of user message, compacted message, or stream completion time
 * - lastReadTimestamp: persisted in localStorage, updated when workspace is selected
 * - isUnread: recencyTimestamp > lastReadTimestamp
 *
 * Behavior under test: stream completion should make non-selected workspaces unread,
 * while selected workspaces should be auto-marked as read.
 */

import "../dom";
import { fireEvent, waitFor } from "@testing-library/react";

import { generateBranchName } from "../../ipc/helpers";
import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness, type AppHarness } from "../harness";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";
import { getWorkspaceLastReadKey } from "@/common/constants/storage";
import { detectDefaultTrunkBranch } from "@/node/git";

/**
 * Get the unread state for a workspace from the WorkspaceStore.
 */
function getWorkspaceUnreadState(workspaceId: string): {
  recencyTimestamp: number | null;
  isUnread: (lastReadTimestamp: number) => boolean;
} {
  const state = workspaceStore.getWorkspaceSidebarState(workspaceId);
  return {
    recencyTimestamp: state.recencyTimestamp,
    isUnread: (lastReadTimestamp: number) =>
      state.recencyTimestamp !== null && state.recencyTimestamp > lastReadTimestamp,
  };
}

/**
 * Get the lastReadTimestamp from persisted state.
 */
function getLastReadTimestamp(workspaceId: string): number {
  return readPersistedState<number>(getWorkspaceLastReadKey(workspaceId), 0);
}

/**
 * Find the workspace element in the sidebar and check if it shows the unread indicator.
 */
function getWorkspaceUnreadIndicator(
  container: HTMLElement,
  workspaceId: string
): { element: HTMLElement; hasUnreadBar: boolean } | null {
  const workspaceEl = container.querySelector<HTMLElement>(`[data-workspace-id="${workspaceId}"]`);

  if (!workspaceEl) return null;

  // The unread indicator is a StatusDot span with the idle/unread styling
  const statusDot = workspaceEl.querySelector('span[class*="bg-surface-invert-secondary"]');

  return {
    element: workspaceEl,
    hasUnreadBar: statusDot !== null && !statusDot.className.includes("opacity-0"),
  };
}

describe("Unread indicator (mock AI router)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  describe("basic unread tracking", () => {
    let app: AppHarness;

    beforeEach(async () => {
      app = await createAppHarness({ branchPrefix: "unread" });
    });

    afterEach(async () => {
      await app.dispose();
    });

    test("workspace is not unread when first opened", async () => {
      // When a workspace is first selected, it should not show as unread
      const lastRead = getLastReadTimestamp(app.workspaceId);
      const { recencyTimestamp: _recencyTimestamp, isUnread } = getWorkspaceUnreadState(
        app.workspaceId
      );

      // A fresh workspace may have recencyTimestamp from createdAt
      // but lastReadTimestamp should be set when we selected it
      expect(lastRead).toBeGreaterThan(0);
      expect(isUnread(lastRead)).toBe(false);
    });

    test("recencyTimestamp updates when user sends a message", async () => {
      const beforeSend = getWorkspaceUnreadState(app.workspaceId);
      const beforeRecency = beforeSend.recencyTimestamp;

      await app.chat.send("Hello, this is a test message");
      await app.chat.expectTranscriptContains("Mock response: Hello, this is a test message");

      const afterSend = getWorkspaceUnreadState(app.workspaceId);

      // Recency should have updated to reflect the user message timestamp
      expect(afterSend.recencyTimestamp).not.toBeNull();
      if (beforeRecency !== null) {
        expect(afterSend.recencyTimestamp).toBeGreaterThanOrEqual(beforeRecency);
      }
    });

    test("recencyTimestamp is stable after stream completes (no further changes without new activity)", async () => {
      // Recency now includes stream completion time.
      // This test validates that once the stream is done, recency stays stable
      // unless there is additional activity.

      await app.chat.send("First message");
      await app.chat.expectTranscriptContains("Mock response: First message");
      await app.chat.expectStreamComplete();

      const afterFirstMessage = getWorkspaceUnreadState(app.workspaceId);
      const recencyAfterFirst = afterFirstMessage.recencyTimestamp;

      // Wait a bit to ensure any timing differences would be detectable
      await new Promise((r) => setTimeout(r, 50));

      // Stream completion already happened before we captured recencyAfterFirst,
      // so without new activity the value should remain unchanged.
      const currentState = getWorkspaceUnreadState(app.workspaceId);
      expect(currentState.recencyTimestamp).toBe(recencyAfterFirst);
    });
  });

  describe("unread indicator during streaming", () => {
    let app: AppHarness;

    beforeEach(async () => {
      app = await createAppHarness({ branchPrefix: "unread-stream" });
    });

    afterEach(async () => {
      await app.dispose();
    });

    test("workspace should NOT show unread after stream completes while viewing it", async () => {
      // This is the bug scenario:
      // 1. User is viewing workspace A
      // 2. User sends message
      // 3. Stream starts and completes
      // 4. Workspace should NOT show as unread (user is actively viewing it)

      await app.chat.send("Test message for unread bug");
      await app.chat.expectTranscriptContains("Mock response: Test message for unread bug");
      await app.chat.expectStreamComplete();

      // After stream completes, check unread state
      const lastReadAfter = getLastReadTimestamp(app.workspaceId);
      const { recencyTimestamp, isUnread } = getWorkspaceUnreadState(app.workspaceId);

      // The workspace should NOT be unread while we're viewing it.
      // handleResponseComplete marks the selected workspace as read when a final
      // stream completes, even though stream completion bumps recency.
      expect(isUnread(lastReadAfter)).toBe(false);

      // lastReadTimestamp should be >= recencyTimestamp after the fix
      if (recencyTimestamp !== null) {
        expect(lastReadAfter).toBeGreaterThanOrEqual(recencyTimestamp);
      }
    });

    test("selected workspace lastRead is updated on stream completion", async () => {
      const lastReadBefore = getLastReadTimestamp(app.workspaceId);
      const beforeSend = Date.now();

      await app.chat.send("Test for read update");
      await app.chat.expectTranscriptContains("Mock response: Test for read update");
      await app.chat.expectStreamComplete();
      const afterComplete = Date.now();

      const lastRead = getLastReadTimestamp(app.workspaceId);
      const { recencyTimestamp } = getWorkspaceUnreadState(app.workspaceId);

      // handleResponseComplete updates selected workspace lastRead before any
      // notification-related early return logic.
      expect(lastRead).toBeGreaterThanOrEqual(lastReadBefore);
      expect(lastRead).toBeGreaterThanOrEqual(beforeSend);
      expect(lastRead).toBeLessThanOrEqual(afterComplete + 1000);
      // Both lastRead and recencyTimestamp use the same completedAt value
      // captured once in handleStreamEnd — exact equality, no ms-boundary race.
      if (recencyTimestamp !== null) {
        expect(lastRead).toBe(recencyTimestamp);
      }
    });

    test("stream completion bumps recency for unread detection", async () => {
      // Core behavior: stream completion now bumps recencyTimestamp,
      // so a non-active reader should see this workspace as unread.
      await app.chat.send("Message to trigger stream");
      await app.chat.expectTranscriptContains("Mock response: Message to trigger stream");
      await app.chat.expectStreamComplete();

      const { recencyTimestamp, isUnread } = getWorkspaceUnreadState(app.workspaceId);
      expect(recencyTimestamp).not.toBeNull();

      // Simulate someone who last read this workspace before stream completion.
      const lastReadBeforeStreamCompleted = recencyTimestamp! - 1000;
      expect(isUnread(lastReadBeforeStreamCompleted)).toBe(true);
    });

    test("workspace should show unread when activity happens in non-selected workspace", async () => {
      // Simulate activity in a workspace the user is NOT viewing
      // by temporarily switching away

      // First, send a message while viewing
      await app.chat.send("Initial message");
      await app.chat.expectTranscriptContains("Mock response: Initial message");

      // Record timestamps
      const recencyAfterFirstMsg = getWorkspaceUnreadState(app.workspaceId).recencyTimestamp;

      // Simulate "looking away" by setting lastReadTimestamp to the past
      const pastTime = (recencyAfterFirstMsg ?? Date.now()) - 10000;
      updatePersistedState(getWorkspaceLastReadKey(app.workspaceId), pastTime);

      // Now simulate another message arriving (as if from background)
      await app.chat.send("Second message while away");
      await app.chat.expectTranscriptContains("Mock response: Second message while away");

      // The workspace should now show as unread
      const { isUnread, recencyTimestamp } = getWorkspaceUnreadState(app.workspaceId);
      expect(recencyTimestamp).not.toBeNull();
      expect(isUnread(pastTime)).toBe(true);
    });

    test("stream completion does NOT mark read when settings page is active", async () => {
      // Regression: stream completion should not advance lastRead when the user
      // is on a non-chat route (e.g. settings). The workspace remains "selected"
      // but the chat content is not visible.

      // Send a gated message so the stream stays pending while we navigate away.
      await app.chat.send("[mock:wait-start] completion while in settings");
      const lastReadAfterSend = getLastReadTimestamp(app.workspaceId);

      // Navigate to settings — this replaces AIView with SettingsPage.
      const settingsButton = app.view.container.querySelector('[data-testid="settings-button"]')!;
      expect(settingsButton).not.toBeNull();
      fireEvent.click(settingsButton);

      // Verify chat view is no longer rendered.
      await waitFor(() => {
        const messageWindow = app.view.container.querySelector('[data-testid="message-window"]');
        if (messageWindow) {
          throw new Error("Expected settings to replace AIView");
        }
      });

      // Release the stream gate so the stream completes while settings are active.
      app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
      await app.chat.expectStreamComplete();

      // lastRead should NOT have advanced — the user wasn't looking at chat.
      const lastReadAfterComplete = getLastReadTimestamp(app.workspaceId);
      expect(lastReadAfterComplete).toBe(lastReadAfterSend);

      // The workspace should show as unread (recency > lastRead).
      await waitFor(() => {
        const { recencyTimestamp, isUnread } = getWorkspaceUnreadState(app.workspaceId);
        expect(recencyTimestamp).not.toBeNull();
        expect(isUnread(lastReadAfterComplete)).toBe(true);
      });
    }, 60_000);

    test("focus while on settings does NOT mark read", async () => {
      // Regression: window focus should not advance lastRead when the user
      // is on a non-chat route, even if a workspace is selected.

      // Send a gated message so the stream stays pending while we navigate away.
      await app.chat.send("[mock:wait-start] focus bypass test");
      const lastReadAfterSend = getLastReadTimestamp(app.workspaceId);

      // Navigate to settings — this replaces AIView with SettingsPage.
      const settingsButton = app.view.container.querySelector('[data-testid="settings-button"]')!;
      expect(settingsButton).not.toBeNull();
      fireEvent.click(settingsButton);

      // Verify chat view is no longer rendered.
      await waitFor(() => {
        const messageWindow = app.view.container.querySelector('[data-testid="message-window"]');
        if (messageWindow) {
          throw new Error("Expected settings to replace AIView");
        }
      });

      // Release the stream gate so the stream completes while settings are active.
      app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
      await app.chat.expectStreamComplete();

      // Simulate the user alt-tabbing back (window regains focus while still on settings).
      const lastReadAfterComplete = getLastReadTimestamp(app.workspaceId);
      expect(lastReadAfterComplete).toBe(lastReadAfterSend);
      window.dispatchEvent(new Event("focus"));

      // lastRead should NOT have advanced — the user still isn't looking at chat.
      const lastReadAfterFocus = getLastReadTimestamp(app.workspaceId);
      expect(lastReadAfterFocus).toBe(lastReadAfterComplete);

      // The workspace should show as unread (recency > lastRead).
      await waitFor(() => {
        const { recencyTimestamp, isUnread } = getWorkspaceUnreadState(app.workspaceId);
        expect(recencyTimestamp).not.toBeNull();
        expect(isUnread(lastReadAfterFocus)).toBe(true);
      });
    }, 60_000);
    test("expectStreamComplete does not resolve before stream-start in gated flows", async () => {
      // Regression: expectStreamComplete() used to check only canInterrupt,
      // which is false before stream-start — allowing early resolution in
      // gated flows before handleStreamEnd finalizes state.

      await app.chat.send("[mock:wait-start] gated stream-complete wait");

      // Start the stream-complete wait BEFORE releasing the gate.
      // We intentionally avoid asserting a specific intermediate sidebar phase
      // here because CI timing can race between `isStarting` and `canInterrupt`
      // even though the core contract (wait does not resolve before gate release)
      // remains the same.
      let resolved = false;
      const waitPromise = app.chat.expectStreamComplete(10_000).then(() => {
        resolved = true;
      });

      // Flush microtasks — if expectStreamComplete incorrectly resolves
      // during isStarting, `resolved` would become true here.
      await Promise.resolve();
      expect(resolved).toBe(false);

      // Release the gate and let the stream complete normally.
      app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
      await waitPromise;
    }, 60_000);
  });

  describe("unread bar visibility", () => {
    let app: AppHarness;

    beforeEach(async () => {
      app = await createAppHarness({ branchPrefix: "unread-bar" });
    });

    afterEach(async () => {
      await app.dispose();
    });

    test("unread bar is hidden when workspace is selected", async () => {
      // Even if isUnread is true, the unread bar should be hidden when selected

      // Force unread state by backdating lastReadTimestamp
      await app.chat.send("Test message");
      await app.chat.expectTranscriptContains("Mock response: Test message");

      const recency = getWorkspaceUnreadState(app.workspaceId).recencyTimestamp;
      const pastTime = (recency ?? Date.now()) - 5000;
      updatePersistedState(getWorkspaceLastReadKey(app.workspaceId), pastTime);

      // Wait for state to propagate
      await waitFor(() => {
        const { isUnread } = getWorkspaceUnreadState(app.workspaceId);
        expect(isUnread(pastTime)).toBe(true);
      });

      // But the unread bar should still be hidden because the workspace is selected
      const indicator = getWorkspaceUnreadIndicator(app.view.container, app.workspaceId);
      expect(indicator).not.toBeNull();
      // showUnreadBar has condition: !(isSelected && !isDisabled)
      // Since workspace is selected, unread bar should not show
      expect(indicator?.hasUnreadBar).toBe(false);
    });
  });

  describe("manual mark unread", () => {
    let app: AppHarness;
    let createdWorkspaceIds: string[];

    function queryMenuItem(label: string): HTMLButtonElement | null {
      const menuButtons = Array.from(document.querySelectorAll("button"));
      return menuButtons.find((button) => button.textContent?.includes(label)) ?? null;
    }

    async function openWorkspaceActionsMenu(displayTitle: string): Promise<void> {
      const menuButton = await waitFor(
        () => {
          const button = app.view.container.querySelector(
            `button[aria-label="Workspace actions for ${displayTitle}"]`
          );
          if (!button) {
            throw new Error(`Workspace actions button not found for ${displayTitle}`);
          }
          return button;
        },
        { timeout: 10_000 }
      );

      fireEvent.click(menuButton);

      await waitFor(
        () => {
          const generateTitleButton = queryMenuItem("Generate new title");
          if (!generateTitleButton) {
            throw new Error("Workspace actions menu did not open");
          }
        },
        { timeout: 10_000 }
      );
    }

    async function createNonSelectedWorkspace(branchPrefix: string): Promise<{
      workspaceId: string;
      displayTitle: string;
    }> {
      const trunkBranch = await detectDefaultTrunkBranch(app.repoPath);
      const createResult = await app.env.orpc.workspace.create({
        projectPath: app.repoPath,
        branchName: generateBranchName(branchPrefix),
        trunkBranch,
      });
      if (!createResult.success) {
        throw new Error(`Failed to create workspace: ${createResult.error}`);
      }

      const createdWorkspace = createResult.metadata;
      createdWorkspaceIds.push(createdWorkspace.id);
      const displayTitle = createdWorkspace.title ?? createdWorkspace.name;

      await waitFor(
        () => {
          const workspaceRow = app.view.container.querySelector(
            `[data-workspace-id="${createdWorkspace.id}"]`
          );
          if (!workspaceRow) {
            throw new Error("Created workspace row not visible yet");
          }
        },
        { timeout: 10_000 }
      );

      await waitFor(
        () => {
          const { recencyTimestamp } = workspaceStore.getWorkspaceSidebarState(createdWorkspace.id);
          if (recencyTimestamp === null) {
            throw new Error("Created workspace has no recency timestamp yet");
          }
        },
        { timeout: 10_000 }
      );

      return {
        workspaceId: createdWorkspace.id,
        displayTitle,
      };
    }

    function getWorkspaceTitleElement(
      workspaceId: string,
      displayTitle: string
    ): HTMLSpanElement | null {
      const workspaceRow = app.view.container.querySelector(`[data-workspace-id="${workspaceId}"]`);
      if (!workspaceRow) {
        return null;
      }

      const textSpans = Array.from(workspaceRow.querySelectorAll("span"));
      return textSpans.find((span) => span.textContent?.trim() === displayTitle) ?? null;
    }

    beforeEach(async () => {
      app = await createAppHarness({ branchPrefix: "unread-manual" });
      createdWorkspaceIds = [];
    });

    afterEach(async () => {
      for (const workspaceId of createdWorkspaceIds) {
        await app.env.orpc.workspace
          .remove({ workspaceId, options: { force: true } })
          .catch(() => {});
      }
      await app.dispose();
    });

    test("shows Mark unread for a read, non-selected workspace row", async () => {
      const otherWorkspace = await createNonSelectedWorkspace("unread-mark-read");
      updatePersistedState(
        getWorkspaceLastReadKey(otherWorkspace.workspaceId),
        Date.now() + 60_000
      );

      await waitFor(() => {
        const indicator = getWorkspaceUnreadIndicator(
          app.view.container,
          otherWorkspace.workspaceId
        );
        if (!indicator) {
          throw new Error("Expected unread indicator container for created workspace");
        }
        expect(indicator.hasUnreadBar).toBe(false);
      });

      await openWorkspaceActionsMenu(otherWorkspace.displayTitle);
      await waitFor(() => {
        expect(queryMenuItem("Mark unread")).not.toBeNull();
      });
    });

    test("clicking Mark unread restores unread visuals", async () => {
      const otherWorkspace = await createNonSelectedWorkspace("unread-mark-click");
      updatePersistedState(
        getWorkspaceLastReadKey(otherWorkspace.workspaceId),
        Date.now() + 60_000
      );

      await waitFor(() => {
        const indicator = getWorkspaceUnreadIndicator(
          app.view.container,
          otherWorkspace.workspaceId
        );
        if (!indicator) {
          throw new Error("Expected unread indicator container for created workspace");
        }
        expect(indicator.hasUnreadBar).toBe(false);
      });

      await openWorkspaceActionsMenu(otherWorkspace.displayTitle);
      const markUnreadButton = await waitFor(
        () => {
          const button = queryMenuItem("Mark unread");
          if (!button) {
            throw new Error("Mark unread menu item not found");
          }
          return button;
        },
        { timeout: 10_000 }
      );
      fireEvent.click(markUnreadButton);

      await waitFor(() => {
        const indicator = getWorkspaceUnreadIndicator(
          app.view.container,
          otherWorkspace.workspaceId
        );
        if (!indicator) {
          throw new Error("Expected unread indicator container for created workspace");
        }
        expect(indicator.hasUnreadBar).toBe(true);
      });

      await waitFor(() => {
        const titleElement = getWorkspaceTitleElement(
          otherWorkspace.workspaceId,
          otherWorkspace.displayTitle
        );
        if (!titleElement) {
          throw new Error("Workspace title element not found");
        }
        expect(titleElement.className).toContain("text-content-primary");
        expect(titleElement.className).not.toContain("text-secondary");
      });
    });

    test("hides Mark unread for already-unread rows", async () => {
      const otherWorkspace = await createNonSelectedWorkspace("unread-mark-already");
      const recencyTimestamp = workspaceStore.getWorkspaceSidebarState(
        otherWorkspace.workspaceId
      ).recencyTimestamp;
      expect(recencyTimestamp).not.toBeNull();
      updatePersistedState(
        getWorkspaceLastReadKey(otherWorkspace.workspaceId),
        (recencyTimestamp ?? Date.now()) - 5_000
      );

      await waitFor(() => {
        const indicator = getWorkspaceUnreadIndicator(
          app.view.container,
          otherWorkspace.workspaceId
        );
        if (!indicator) {
          throw new Error("Expected unread indicator container for created workspace");
        }
        expect(indicator.hasUnreadBar).toBe(true);
      });

      await openWorkspaceActionsMenu(otherWorkspace.displayTitle);
      await waitFor(() => {
        expect(queryMenuItem("Mark unread")).toBeNull();
      });
    });

    test("hides Mark unread for selected rows", async () => {
      const selectedDisplayTitle = app.metadata.title ?? app.metadata.name;

      await waitFor(() => {
        const selectedRow = app.view.container.querySelector(
          `[data-workspace-id="${app.workspaceId}"]`
        );
        if (!selectedRow) {
          throw new Error("Selected workspace row not found");
        }
        expect(selectedRow.getAttribute("aria-current")).toBe("true");
      });

      await openWorkspaceActionsMenu(selectedDisplayTitle);
      await waitFor(() => {
        expect(queryMenuItem("Mark unread")).toBeNull();
      });
    });
  });

  describe("recency computation correctness", () => {
    let app: AppHarness;

    beforeEach(async () => {
      app = await createAppHarness({ branchPrefix: "recency" });
    });

    afterEach(async () => {
      await app.dispose();
    });

    test("recencyTimestamp reflects stream completion time", async () => {
      // Send a user message and note the recency
      const beforeSend = Date.now();
      await app.chat.send("User message for recency test");

      // Wait for stream to complete
      await app.chat.expectTranscriptContains("Mock response: User message for recency test");
      const afterComplete = Date.now();

      const { recencyTimestamp } = getWorkspaceUnreadState(app.workspaceId);

      // Recency now includes stream completion time, so it should fall within
      // the send/completion window.
      expect(recencyTimestamp).not.toBeNull();
      // Allow some tolerance for timing
      expect(recencyTimestamp!).toBeGreaterThanOrEqual(beforeSend - 100);
      // Recency should be no later than shortly after completion.
      expect(recencyTimestamp!).toBeLessThan(afterComplete + 1000);
    });

    test("multiple user messages update recencyTimestamp to the latest", async () => {
      await app.chat.send("First message");
      await app.chat.expectTranscriptContains("Mock response: First message");

      const recency1 = getWorkspaceUnreadState(app.workspaceId).recencyTimestamp;

      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 50));

      await app.chat.send("Second message");
      await app.chat.expectTranscriptContains("Mock response: Second message");

      const recency2 = getWorkspaceUnreadState(app.workspaceId).recencyTimestamp;

      expect(recency2).not.toBeNull();
      expect(recency1).not.toBeNull();
      expect(recency2!).toBeGreaterThan(recency1!);
    });
  });
});
