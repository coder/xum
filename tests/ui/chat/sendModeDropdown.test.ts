import "../dom";

jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));

import { fireEvent, waitFor } from "@testing-library/react";

import { preloadTestModules, type TestEnvironment } from "../../ipc/setup";

import { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";

import { createAppHarness, type AppHarness } from "../harness";

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

async function getComposerDockTextarea(container: HTMLElement): Promise<HTMLTextAreaElement> {
  return waitFor(
    () => {
      const dock = container.querySelector('[data-testid="chat-composer-dock"]');
      if (!dock) {
        throw new Error("Chat composer dock not found");
      }

      const textarea = dock.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Message Claude"]'
      );
      if (!textarea) {
        throw new Error("Composer textarea not found");
      }
      if (textarea.disabled) {
        throw new Error("Composer textarea is disabled");
      }

      return textarea;
    },
    { timeout: 10_000 }
  );
}

async function startStreamingTurn(app: AppHarness, label: string): Promise<void> {
  // Keep stream alive so queued-send mode chooser can be used.
  const longStreamingTail = " keep-streaming".repeat(600);
  await app.chat.send(`[mock:wait-start] ${label}${longStreamingTail}`);
  app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
}

async function waitForSendModeMenuTrigger(container: HTMLElement): Promise<HTMLButtonElement> {
  return waitFor(
    () => {
      const buttons = Array.from(
        container.querySelectorAll<HTMLButtonElement>('button[aria-label="Send message"]')
      );
      const trigger = [...buttons]
        .reverse()
        .find((button) => button.getAttribute("aria-haspopup") === "menu" && !button.disabled);
      if (!trigger) {
        throw new Error("Send mode menu trigger not ready");
      }
      return trigger;
    },
    { timeout: 30_000 }
  );
}

async function openSendModeMenu(container: HTMLElement): Promise<void> {
  const trigger = await waitForSendModeMenuTrigger(container);
  fireEvent.contextMenu(trigger, { clientX: 12, clientY: 12 });

  await waitFor(
    () => {
      const row = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Send after turn")
      );
      if (!row) {
        throw new Error("Send mode menu did not open");
      }
    },
    { timeout: 30_000 }
  );
}

describe("Send dispatch modes (mock AI router)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("does not render a send mode caret trigger next to the send button", async () => {
    const app = await createAppHarness({ branchPrefix: "send-mode-tooltip" });

    try {
      const modeTrigger = app.view.container.querySelector(
        'button[aria-label="Send mode options"]'
      );
      expect(modeTrigger).toBeNull();
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("running goals pause on manual sends and omit a redundant pause send action", async () => {
    const app = await createAppHarness({ branchPrefix: "send-mode-goal-policy" });

    try {
      const created = await app.env.orpc.workspace.setGoal({
        workspaceId: app.workspaceId,
        objective: "Keep dogfooding send policy",
        budgetCents: null,
      });
      expect(created.success).toBe(true);

      await waitFor(() => {
        expect(workspaceStore.getWorkspaceSidebarState(app.workspaceId).goal?.status).toBe(
          "active"
        );
      });

      await app.chat.typeWithoutSending("Manual note pauses the goal");
      await openSendModeMenu(app.view.container);
      const rows = Array.from(app.view.container.querySelectorAll("button"));
      expect(rows.some((button) => button.textContent?.includes("Send and pause goal"))).toBe(
        false
      );
      const sendAfterTurnRow = rows.find((button) =>
        button.textContent?.includes("Send after turn")
      );
      if (!sendAfterTurnRow) {
        throw new Error("Send after turn row not found");
      }
      fireEvent.click(sendAfterTurnRow);
      await app.chat.expectStreamComplete();

      await waitFor(async () => {
        const { goal } = await app.env.orpc.workspace.getGoal({ workspaceId: app.workspaceId });
        expect(goal?.status).toBe("paused");
      });
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("send after step waits for every tool call emitted in the current step", async () => {
    const app = await createAppHarness({ branchPrefix: "queued-parallel-tool-step" });

    try {
      await app.chat.send("[mock:tool:parallel-step] Run both sibling tool calls");
      await waitFor(() => {
        const state = workspaceStore.getWorkspaceSidebarState(app.workspaceId);
        if (!state.canInterrupt) {
          throw new Error("Expected the source turn to be streaming before queueing");
        }
      });

      const queuedText = "follow up after the complete tool step";
      await app.chat.typeWithoutSending(queuedText);
      const sendButton = await waitForSendModeMenuTrigger(app.view.container);
      fireEvent.click(sendButton);
      await waitFor(() => {
        expect(app.view.container.textContent).toContain("Queued");
        expect(app.view.container.textContent).toContain("Sends after this step");
      });

      await app.chat.expectTranscriptContains("parallel-step-a.txt");
      await app.chat.expectTranscriptContains("parallel-step-b.txt");
      await app.chat.expectTranscriptContains(
        "Finished both sibling tool calls before continuing."
      );
      await app.chat.expectTranscriptContains(`Mock response: ${queuedText}`);
      await app.chat.expectStreamComplete();
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("queued send keybinds update the boundary and can send immediately", async () => {
    const app = await createAppHarness({ branchPrefix: "queued-enter-send-now" });

    try {
      await startStreamingTurn(app, "queued enter source");
      await waitFor(
        () => {
          const state = workspaceStore.getWorkspaceSidebarState(app.workspaceId);
          if (!state.canInterrupt) {
            throw new Error("Expected source stream to be interruptible");
          }
        },
        { timeout: 30_000 }
      );

      const queuedText = "queued enter send now test";
      await app.chat.typeWithoutSending(queuedText);
      await openSendModeMenu(app.view.container);
      const sendAfterTurnRow = await waitFor(
        () => {
          const row = Array.from(app.view.container.querySelectorAll("button")).find((button) =>
            button.textContent?.includes("Send after turn")
          );
          if (!row) {
            throw new Error("Send after turn row not found");
          }
          return row;
        },
        { timeout: 30_000 }
      );
      fireEvent.click(sendAfterTurnRow);

      await waitFor(() => {
        const textContent = app.view.container.textContent ?? "";
        expect(textContent).toContain("Queued");
        expect(textContent).toContain("Sends after this turn");
        expect(
          app.view.container.querySelector('[data-component="QueuedMessageDispatchMenu"]')
        ).toBeNull();
      });

      const queuedDispatchButton = app.view.container.querySelector<HTMLButtonElement>(
        '[data-component="QueuedMessageStatus"]'
      );
      if (!queuedDispatchButton) {
        throw new Error("Queued dispatch dropdown not found");
      }
      fireEvent.click(queuedDispatchButton);
      const queuedDispatchMenu = await waitFor(() => {
        const menu = app.view.container.querySelector<HTMLElement>(
          '[data-component="QueuedMessageDispatchMenu"]'
        );
        expect(menu?.textContent).toContain("Send after step");
        expect(menu?.textContent).toContain("Send after turn");
        expect(menu?.textContent).toContain("Send now");
        if (!menu) throw new Error("Queued dispatch menu not rendered");
        return menu;
      });
      const sendAfterStepRow = Array.from(queuedDispatchMenu.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Send after step")
      );
      if (!sendAfterStepRow) throw new Error("Queued Send after step action not found");
      fireEvent.click(sendAfterStepRow);
      await waitFor(() => {
        expect(app.view.container.textContent).toContain("Sends after this step");
        expect(app.view.container.textContent).not.toContain("Sends after this turn");
        expect(app.view.container.textContent).toContain(queuedText);
      });

      const textarea = await getComposerDockTextarea(app.view.container);
      await waitFor(() => {
        expect(textarea.value).toBe("");
      });

      textarea.focus();
      fireEvent.keyDown(textarea, {
        key: "Enter",
        code: "Enter",
        charCode: 13,
        ctrlKey: true,
      });
      await waitFor(() => {
        expect(app.view.container.textContent).toContain("Sends after this turn");
      });

      fireEvent.keyDown(textarea, { key: "Enter", code: "Enter", charCode: 13 });
      await waitFor(() => {
        expect(app.view.container.textContent).toContain("Sends after this step");
      });

      fireEvent.keyDown(textarea, {
        key: "Enter",
        code: "Enter",
        charCode: 13,
        ctrlKey: true,
        shiftKey: true,
      });
      // A fast repeated send-now shortcut should be ignored while the interrupt is in flight.
      fireEvent.keyDown(textarea, {
        key: "Enter",
        code: "Enter",
        charCode: 13,
        ctrlKey: true,
        shiftKey: true,
        repeat: true,
      });

      await waitFor(
        () => {
          expect(app.view.container.textContent).not.toContain("Sends after this step");
        },
        { timeout: 30_000 }
      );
      await app.chat.expectTranscriptContains(`Mock response: ${queuedText}`, 60_000);
      await app.chat.expectStreamComplete(60_000);
      const responseMatches = app.view.container.textContent?.match(
        new RegExp(`Mock response: ${queuedText}`, "g")
      );
      expect(responseMatches).toHaveLength(1);
    } finally {
      await app.dispose();
    }
  }, 60_000);

  // This end-to-end-style case drives several streaming turns and foreground-tool transitions,
  // so give loaded CI runners more than the default per-test budget.
  test("click sends tool-end by default while context menu + keybind dispatch modes remain", async () => {
    const app = await createAppHarness({ branchPrefix: "send-mode-pointer" });

    let unregisterTurn: (() => void) | undefined;
    let unregisterStep: (() => void) | undefined;

    try {
      const idleTurnMessage = "turn-end idle context-menu test";
      await app.chat.typeWithoutSending(idleTurnMessage);
      await openSendModeMenu(app.view.container);

      const idleTurnRow = await waitFor(
        () => {
          const rows = Array.from(app.view.container.querySelectorAll("button"));
          const row = rows.find((button) => button.textContent?.includes("Send after turn"));
          if (!row) {
            throw new Error("Send after turn row not found for idle context menu");
          }
          return row;
        },
        { timeout: 30_000 }
      );
      fireEvent.click(idleTurnRow);

      await app.chat.expectTranscriptContains(`Mock response: ${idleTurnMessage}`);
      await app.chat.expectStreamComplete();

      await startStreamingTurn(app, "click send while streaming");

      const clickStepMessage = "tool-end click test";
      await app.chat.typeWithoutSending(clickStepMessage);
      const sendButton = await waitForSendModeMenuTrigger(app.view.container);
      fireEvent.click(sendButton);

      await waitFor(
        () => {
          const rows = Array.from(app.view.container.querySelectorAll("button"));
          const row = rows.find((button) => button.textContent?.includes("Send after turn"));
          if (row) {
            throw new Error("Left-clicking Send should not open send mode menu");
          }
        },
        { timeout: 5_000 }
      );

      await app.chat.expectTranscriptContains(`Mock response: ${clickStepMessage}`);
      await app.chat.expectStreamComplete();

      await startStreamingTurn(app, "open send mode menu while streaming");

      const pointerTurnMessage = "turn-end pointer test";
      await app.chat.typeWithoutSending(pointerTurnMessage);
      await openSendModeMenu(app.view.container);

      fireEvent.keyDown(document, { key: "Escape" });

      await waitFor(
        () => {
          const rows = Array.from(app.view.container.querySelectorAll("button"));
          const row = rows.find((button) => button.textContent?.includes("Send after turn"));
          if (row) {
            throw new Error("Send mode menu should close on Escape");
          }
        },
        { timeout: 30_000 }
      );

      // Re-open after Escape: if Escape interrupted the stream, this menu cannot open.
      await openSendModeMenu(app.view.container);

      const turnRow = await waitFor(
        () => {
          const rows = Array.from(app.view.container.querySelectorAll("button"));
          const row = rows.find((button) => button.textContent?.includes("Send after turn"));
          if (!row) {
            throw new Error("Send after turn row not found");
          }
          return row;
        },
        { timeout: 30_000 }
      );
      fireEvent.click(turnRow);

      await app.chat.expectTranscriptContains(`Mock response: ${pointerTurnMessage}`);
      await app.chat.expectStreamComplete();

      const manager = getBackgroundProcessManager(app.env);

      const turnToolCallId = "bash-foreground-send-after-turn";
      let turnBackgrounded = false;

      const turnRegistration = manager.registerForegroundProcess(
        app.workspaceId,
        turnToolCallId,
        "echo foreground bash for send-after-turn",
        "foreground bash for send-after-turn",
        () => {
          turnBackgrounded = true;
          unregisterTurn?.();
        }
      );

      unregisterTurn = turnRegistration.unregister;

      await waitForForegroundToolCallId(app.env, app.workspaceId, turnToolCallId);

      const turnEndMessage = "turn-end keyboard test";
      await app.chat.typeWithoutSending(turnEndMessage);
      let textarea = await getActiveTextarea(app.view.container);
      fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

      await app.chat.expectTranscriptContains(`Mock response: ${turnEndMessage}`);
      await app.chat.expectStreamComplete();
      expect(turnBackgrounded).toBe(false);

      const stepToolCallId = "bash-foreground-send-after-step";
      let stepBackgrounded = false;

      const stepRegistration = manager.registerForegroundProcess(
        app.workspaceId,
        stepToolCallId,
        "echo foreground bash for send-after-step",
        "foreground bash for send-after-step",
        () => {
          stepBackgrounded = true;
          unregisterStep?.();
        }
      );

      unregisterStep = stepRegistration.unregister;

      await waitForForegroundToolCallId(app.env, app.workspaceId, stepToolCallId);

      const stepEndMessage = "tool-end test";
      await app.chat.typeWithoutSending(stepEndMessage);
      textarea = await getActiveTextarea(app.view.container);
      fireEvent.keyDown(textarea, { key: "Enter" });

      await app.chat.expectTranscriptContains(`Mock response: ${stepEndMessage}`);
      await waitFor(
        () => {
          expect(stepBackgrounded).toBe(true);
        },
        { timeout: 60_000 }
      );
      await app.chat.expectStreamComplete();
    } finally {
      unregisterTurn?.();
      unregisterStep?.();
      await app.dispose();
    }
  }, 120_000);
});
