/**
 * UI integration tests for compaction flows.
 *
 * Goal: validate UI logic <-> backend integration without relying on real LLMs.
 *
 * These tests run with the mock AI router enabled via createAppHarness().
 */

import "../dom";
import { waitFor } from "@testing-library/react";

import { preloadTestModules, type TestEnvironment } from "../../ipc/setup";

import { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";

import { fireEvent } from "@testing-library/react";
import { createAppHarness } from "../harness";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getAutoCompactionThresholdKey } from "@/common/constants/storage";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";
import { resolveAutoCompactionThreshold } from "@/common/utils/compaction/autoCompactionThreshold";

interface ServiceContainerPrivates {
  backgroundProcessManager: BackgroundProcessManager;
}

function getBackgroundProcessManager(env: TestEnvironment): BackgroundProcessManager {
  return (env.services as unknown as ServiceContainerPrivates).backgroundProcessManager;
}

async function waitForForegroundToolCallId(
  env: TestEnvironment,
  workspaceId: string,
  toolCallId: string
): Promise<void> {
  const controller = new AbortController();
  let iterator: AsyncIterator<{ foregroundToolCallIds: string[] }> | null = null;

  try {
    const subscribedIterator = await env.orpc.workspace.backgroundBashes.subscribe(
      { workspaceId },
      { signal: controller.signal }
    );

    iterator = subscribedIterator;

    for await (const state of subscribedIterator) {
      if (state.foregroundToolCallIds.includes(toolCallId)) {
        return;
      }
    }

    throw new Error("backgroundBashes.subscribe ended before foreground bash was observed");
  } finally {
    controller.abort();
    void iterator?.return?.();
  }
}

async function getActiveTextarea(container: HTMLElement): Promise<HTMLTextAreaElement> {
  return waitFor(
    () => {
      const textareas = Array.from(
        container.querySelectorAll<HTMLTextAreaElement>('textarea[aria-label="Message Claude"]')
      );
      if (textareas.length === 0) {
        throw new Error("Chat textarea not found");
      }

      const enabled = [...textareas].reverse().find((textarea) => !textarea.disabled);
      if (!enabled) {
        throw new Error("Chat textarea is disabled");
      }

      return enabled;
    },
    { timeout: 10_000 }
  );
}

const FORCE_THRESHOLD_PERCENT = 10;

/**
 * Move the per-model slider the way the UI does (a persisted-state write that the
 * UserPreferencesProvider mirrors into config.json). 10% threshold + 5% force buffer =>
 * force compaction triggers at 15%.
 */
function moveThresholdSlider(percent: number): void {
  updatePersistedState(getAutoCompactionThresholdKey(WORKSPACE_DEFAULTS.model), percent);
}

/** The backend reads the threshold from config.json; wait until the mirrored write landed. */
async function waitForPersistedThreshold(env: TestEnvironment, fraction: number): Promise<void> {
  await waitFor(
    () => {
      expect(
        resolveAutoCompactionThreshold(
          env.config.loadConfigOrDefault().userPreferences,
          WORKSPACE_DEFAULTS.model
        )
      ).toBe(fraction);
    },
    { timeout: 10_000 }
  );
}

describe("Compaction UI (mock AI router)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("manual /compact with continue message auto-sends after compaction", async () => {
    const app = await createAppHarness({ branchPrefix: "compaction-ui" });

    try {
      const seedMessage = "Seed conversation for compaction";
      const continueText = "Continue after manual compaction";

      await app.chat.send(seedMessage);
      await app.chat.expectTranscriptContains(`Mock response: ${seedMessage}`);

      await app.chat.send(`/compact -t 500\n${continueText}`);

      await app.chat.expectTranscriptContains("Mock compaction summary:");
      await app.chat.expectTranscriptContains(`Mock response: ${continueText}`);
      // Compaction transcript now renders a single top boundary row.
      await app.chat.expectTranscriptContains("Compaction boundary");

      // Live compaction now prunes to the latest boundary, so pre-compaction
      // transcript is no longer visible in the current view.
      await app.chat.expectTranscriptNotContains(seedMessage);
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("auto-compacts after context_exceeded and resumes", async () => {
    const app = await createAppHarness({ branchPrefix: "compaction-ui" });

    try {
      const triggerMessage = "Trigger context error";
      const userDraft = "My draft message that should be preserved";

      await app.chat.send(triggerMessage);

      // User starts typing while auto-compaction is in progress
      await app.chat.typeWithoutSending(userDraft);

      await app.chat.expectTranscriptContains("Mock compaction summary:", 60_000);
      await app.chat.expectTranscriptContains(`Continue with: ${triggerMessage}`, 60_000);
      await app.chat.expectTranscriptContains(`Mock response: ${triggerMessage}`, 60_000);

      // Verify user's draft was NOT overwritten by auto-compaction
      await app.chat.expectInputValue(userDraft);
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("force compaction triggers during streaming", async () => {
    const app = await createAppHarness({ branchPrefix: "compaction-ui" });

    try {
      const seedMessage = "Seed conversation for compaction";
      const triggerMessage = "[force] Trigger force compaction";

      const seedResult = await app.env.orpc.workspace.sendMessage({
        workspaceId: app.workspaceId,
        message: seedMessage,
        options: { model: WORKSPACE_DEFAULTS.model, agentId: WORKSPACE_DEFAULTS.agentId },
      });
      expect(seedResult.success).toBe(true);
      await app.chat.expectTranscriptContains(`Mock response: ${seedMessage}`);
      // Slider, then an immediate composer send: the composer waits for the preference write
      // to be acknowledged, so the backend decides with the new threshold.
      moveThresholdSlider(FORCE_THRESHOLD_PERCENT);
      await app.chat.send(triggerMessage);
      await waitForPersistedThreshold(app.env, FORCE_THRESHOLD_PERCENT / 100);

      const compactionAssertionTimeoutMs = 120_000;
      await app.chat.expectTranscriptContains(
        "Mock compaction summary:",
        compactionAssertionTimeoutMs
      );
      await app.chat.expectTranscriptContains(
        "Mock response: Continue",
        compactionAssertionTimeoutMs
      );
      // Compaction transcript now renders a single top boundary row.
      await app.chat.expectTranscriptContains("Compaction boundary", compactionAssertionTimeoutMs);

      // Force compaction now prunes to the latest boundary window, so the
      // pre-compaction triggering turn is no longer shown.
      await app.chat.expectTranscriptNotContains(triggerMessage, compactionAssertionTimeoutMs);
    } finally {
      await app.dispose();
    }
  }, 120_000);

  test("a slider change whose save fails refuses the send and keeps the draft", async () => {
    const app = await createAppHarness({ branchPrefix: "compaction-ui" });

    try {
      const seedMessage = "Seed before the failing save";
      await app.chat.send(seedMessage);
      await app.chat.expectTranscriptContains(`Mock response: ${seedMessage}`);

      const sendMessage = jest.spyOn(app.env.services.workspaceService, "sendMessage");
      const saveUserConfig = jest
        .spyOn(app.env.config, "saveUserConfig")
        .mockRejectedValue(new Error("disk full"));
      const draft = "Draft that must survive a failed settings save";
      moveThresholdSlider(FORCE_THRESHOLD_PERCENT);
      await waitFor(() => expect(saveUserConfig).toHaveBeenCalled(), { timeout: 10_000 });
      await app.chat.send(draft);

      // The composer refuses the send visibly rather than streaming with a stale threshold.
      await waitFor(
        () => expect(app.view.container.textContent ?? "").toContain("Settings could not be saved"),
        { timeout: 10_000 }
      );
      await app.chat.expectInputValue(draft);
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("/compact command sends any foreground bash to background", async () => {
    const app = await createAppHarness({ branchPrefix: "compaction-ui" });

    let unregister: (() => void) | undefined;

    try {
      const manager = getBackgroundProcessManager(app.env);

      const toolCallId = "bash-foreground-compact";
      let backgrounded = false;

      const registration = manager.registerForegroundProcess(
        app.workspaceId,
        toolCallId,
        "echo foreground bash for compact",
        "foreground bash for compact",
        () => {
          backgrounded = true;
          unregister?.();
        }
      );

      unregister = registration.unregister;

      // Ensure the UI's subscription has observed the foreground bash before sending /compact.
      await waitForForegroundToolCallId(app.env, app.workspaceId, toolCallId);

      const seedMessage = "Seed conversation for /compact test";

      const seedResult = await app.env.orpc.workspace.sendMessage({
        workspaceId: app.workspaceId,
        message: seedMessage,
        options: { model: WORKSPACE_DEFAULTS.model, agentId: WORKSPACE_DEFAULTS.agentId },
      });
      expect(seedResult.success).toBe(true);
      await app.chat.expectTranscriptContains(`Mock response: ${seedMessage}`);

      // Send /compact command via the UI (like a user would)
      await app.chat.send("/compact -t 500");

      await app.chat.expectTranscriptContains("Mock compaction summary:", 60_000);

      await waitFor(
        () => {
          expect(backgrounded).toBe(true);
        },
        { timeout: 60_000 }
      );
    } finally {
      unregister?.();
      await app.dispose();
    }
  }, 60_000);

  test("/compact with Ctrl+Enter (turn-end) does NOT auto-background foreground bash", async () => {
    const app = await createAppHarness({ branchPrefix: "compaction-ui" });

    let unregister: (() => void) | undefined;

    try {
      const manager = getBackgroundProcessManager(app.env);

      const toolCallId = "bash-foreground-compact-turn-end";
      let backgrounded = false;

      const registration = manager.registerForegroundProcess(
        app.workspaceId,
        toolCallId,
        "echo foreground bash for compact turn-end",
        "foreground bash for compact turn-end",
        () => {
          backgrounded = true;
          unregister?.();
        }
      );

      unregister = registration.unregister;

      // Ensure the UI's subscription has observed the foreground bash before sending /compact.
      await waitForForegroundToolCallId(app.env, app.workspaceId, toolCallId);

      const seedMessage = "Seed conversation for /compact turn-end test";

      const seedResult = await app.env.orpc.workspace.sendMessage({
        workspaceId: app.workspaceId,
        message: seedMessage,
        options: { model: WORKSPACE_DEFAULTS.model, agentId: WORKSPACE_DEFAULTS.agentId },
      });
      expect(seedResult.success).toBe(true);
      await app.chat.expectTranscriptContains(`Mock response: ${seedMessage}`);

      await app.chat.typeWithoutSending("/compact -t 500");
      const textarea = await getActiveTextarea(app.view.container);
      fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

      await app.chat.expectTranscriptContains("Mock compaction summary:", 60_000);

      expect(backgrounded).toBe(false);
    } finally {
      unregister?.();
      await app.dispose();
    }
  }, 60_000);

  test("force compaction sends any foreground bash to background", async () => {
    const app = await createAppHarness({ branchPrefix: "compaction-ui" });

    let unregister: (() => void) | undefined;

    try {
      const manager = getBackgroundProcessManager(app.env);

      const toolCallId = "bash-foreground";
      let backgrounded = false;

      const registration = manager.registerForegroundProcess(
        app.workspaceId,
        toolCallId,
        "echo foreground bash",
        "foreground bash",
        () => {
          backgrounded = true;
          unregister?.();
        }
      );

      unregister = registration.unregister;

      // Ensure the UI's subscription has observed the foreground bash before streaming starts.
      await waitForForegroundToolCallId(app.env, app.workspaceId, toolCallId);

      const seedMessage = "Seed conversation for compaction";
      const triggerMessage = "[force] Trigger force compaction";

      const seedResult = await app.env.orpc.workspace.sendMessage({
        workspaceId: app.workspaceId,
        message: seedMessage,
        options: { model: WORKSPACE_DEFAULTS.model, agentId: WORKSPACE_DEFAULTS.agentId },
      });
      expect(seedResult.success).toBe(true);
      await app.chat.expectTranscriptContains(`Mock response: ${seedMessage}`);
      moveThresholdSlider(FORCE_THRESHOLD_PERCENT);
      await waitForPersistedThreshold(app.env, FORCE_THRESHOLD_PERCENT / 100);

      // Send via the UI path so the foreground bash auto-background logic runs exactly
      // as it does for real user sends, while backend mid-stream compaction handles the rest.
      await app.chat.send(triggerMessage);

      await app.chat.expectTranscriptContains("Mock compaction summary:", 60_000);

      await waitFor(
        () => {
          expect(backgrounded).toBe(true);
        },
        { timeout: 60_000 }
      );
    } finally {
      unregister?.();
      await app.dispose();
    }
  }, 120_000);
});

describe("Auto-follow-up and compaction notification behavior (mock AI router)", () => {
  const notifications: { title: string; body?: string }[] = [];
  let originalWindowNotification: unknown;

  beforeAll(async () => {
    await preloadTestModules();
    originalWindowNotification = (globalThis as { Notification?: unknown }).Notification;
  });

  beforeEach(() => {
    notifications.length = 0;

    // Mock Notification constructor - must be on globalThis since happy-dom
    // aliases window = globalThis in our test setup
    class MockNotification {
      onclick: (() => void) | null = null;
      constructor(title: string, options?: { body?: string }) {
        notifications.push({ title, body: options?.body });
      }
      close() {}
    }

    const mockWithPermission = Object.assign(MockNotification, {
      permission: "granted",
      requestPermission: () => Promise.resolve("granted" as NotificationPermission),
    });
    (globalThis as { Notification: unknown }).Notification = mockWithPermission;
  });

  afterEach(() => {
    if (originalWindowNotification !== undefined) {
      (globalThis as { Notification?: unknown }).Notification = originalWindowNotification;
    } else {
      delete (globalThis as { Notification?: unknown }).Notification;
    }
  });

  /** Set up harness with notification mocks, send seed message, return cleanup + count */
  async function setupNotificationTest(seedMessage: string) {
    const app = await createAppHarness({ branchPrefix: "compact-notify" });

    // Mock document.hasFocus AFTER harness creates the DOM window
    // Happy-dom's hasFocus returns !!this.activeElement - clear it to return false
    const originalActiveElement = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(globalThis.document),
      "activeElement"
    );
    Object.defineProperty(globalThis.document, "activeElement", {
      get: () => null,
      configurable: true,
    });

    // Set Notification on the happy-dom window
    (window as { Notification: unknown }).Notification = (
      globalThis as { Notification: unknown }
    ).Notification;

    // Enable notifications via UI (click bell button in workspace header)
    const notifyButton = app.view.container.querySelector(
      '[data-testid="notify-on-response-button"]'
    );
    if (!notifyButton) throw new Error("Notify button not found");
    fireEvent.click(notifyButton);

    // Send seed message and wait for notification
    await app.chat.send(seedMessage);
    await app.chat.expectTranscriptContains(`Mock response: ${seedMessage}`);
    await waitFor(() => expect(notifications.length).toBeGreaterThanOrEqual(1), { timeout: 5_000 });

    const countAfterSeed = notifications.length;
    expect(countAfterSeed).toBe(1);

    const cleanup = async () => {
      if (originalActiveElement) {
        Object.defineProperty(globalThis.document, "activeElement", originalActiveElement);
      }
      await app.dispose();
    };

    return { app, countAfterSeed, cleanup };
  }

  /** Wait for new notifications after seed, return count and last notification */
  async function waitForNewNotifications(countAfterSeed: number) {
    await waitFor(() => expect(notifications.length).toBeGreaterThanOrEqual(countAfterSeed + 1), {
      timeout: 5_000,
    });
    return {
      newCount: notifications.length - countAfterSeed,
      last: notifications[notifications.length - 1],
    };
  }

  test("queued auto-follow-up should fire only ONE notification (for the follow-up response)", async () => {
    const { app, countAfterSeed, cleanup } = await setupNotificationTest(
      "Seed for queued follow-up notification test"
    );
    const streamingMessage = `[mock:wait-start] queued follow-up notification${" keep-streaming".repeat(600)}`;
    const followUpText = "Queued follow-up after streaming";

    try {
      await app.chat.send(streamingMessage);
      app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
      await waitFor(
        () => {
          expect(workspaceStore.getWorkspaceSidebarState(app.workspaceId).canInterrupt).toBe(true);
        },
        { timeout: 30_000 }
      );

      await app.chat.send(followUpText);
      await app.chat.expectTranscriptContains(`Mock response: ${followUpText}`);
      await app.chat.expectStreamComplete();

      const { newCount, last } = await waitForNewNotifications(countAfterSeed);
      expect(newCount).toBe(1);
      expect(last.body).toContain(`Mock response: ${followUpText}`);
    } finally {
      await cleanup();
    }
  }, 60_000);

  test("compaction with continue message should fire only ONE notification (for continue response)", async () => {
    const { app, countAfterSeed, cleanup } = await setupNotificationTest(
      "Seed for notification test"
    );
    const continueText = "Continue after compaction";

    try {
      // Send /compact with continue - should NOT fire for compaction, only for continue
      await app.chat.send(`/compact -t 500\n${continueText}`);
      await app.chat.expectTranscriptContains("Mock compaction summary:");
      await app.chat.expectTranscriptContains(`Mock response: ${continueText}`);

      const { newCount, last } = await waitForNewNotifications(countAfterSeed);
      expect(newCount).toBe(1);
      expect(last.body).toContain(`Mock response: ${continueText}`);
      expect(last.body).not.toBe("Compaction complete");
    } finally {
      await cleanup();
    }
  }, 60_000);

  test("compaction without continue message should not fire a notification", async () => {
    const { app, countAfterSeed, cleanup } = await setupNotificationTest(
      "Seed for standalone compaction"
    );

    try {
      await app.chat.send("/compact -t 500");
      await app.chat.expectTranscriptContains("Mock compaction summary:");
      await app.chat.expectStreamComplete();

      expect(notifications.length).toBe(countAfterSeed);
    } finally {
      await cleanup();
    }
  }, 60_000);
});
