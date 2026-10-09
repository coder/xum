/**
 * /side opens a titled side chat tab in the right sidebar: a second live chat pane
 * next to the routed main chat. Drives the real app against the mock AI router.
 */

import "../dom";

// App-level UI tests can hit loader shells first, so stub Lottie before importing the
// harness to keep happy-dom from tripping over lottie-web's canvas bootstrap.
jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));

import { act, fireEvent, waitFor } from "@testing-library/react";

import { getDraftStore } from "@/browser/stores/DraftStore";
import { workspaceStore, useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { SIDE_CHAT_PANE_ATTR } from "@/browser/utils/ui/keybinds";

import { getRightSidebarLayoutKey } from "@/common/constants/storage";
import { updatePersistedState, readPersistedState } from "@/browser/hooks/usePersistedState";
import { collectAllTabs, type RightSidebarLayoutState } from "@/browser/utils/rightSidebarLayout";
import { getRetryBarrierDerivation } from "@/browser/components/ChatPane/retryBarrierDerivation";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness, type AppHarness } from "../harness";

const SIDE_PANE_SELECTOR = `[${SIDE_CHAT_PANE_ATTR}]`;
const COMPOSER_SELECTOR = 'textarea[aria-label="Message"]';

function getSidePane(app: AppHarness): HTMLElement | null {
  return app.view.container.querySelector<HTMLElement>(SIDE_PANE_SELECTOR);
}

/** The routed main chat's composer (the only one outside the side chat pane). */
function getMainComposer(app: AppHarness): HTMLTextAreaElement {
  const composers = Array.from(
    app.view.container.querySelectorAll<HTMLTextAreaElement>(COMPOSER_SELECTOR)
  ).filter((el) => el.closest(SIDE_PANE_SELECTOR) == null);
  if (composers.length !== 1) {
    throw new Error(`Expected one main composer, found ${composers.length}`);
  }
  return composers[0];
}

function getSideComposer(app: AppHarness): HTMLTextAreaElement {
  const composer = getSidePane(app)?.querySelector<HTMLTextAreaElement>(COMPOSER_SELECTOR);
  if (composer == null) throw new Error("Side chat composer not found");
  return composer;
}

/**
 * Send from a specific composer. ChatHarness targets the last composer in DOM order, which is
 * ambiguous once the side pane mounts a second one, so each send names its pane explicitly.
 */
async function sendFrom(
  getComposer: () => HTMLTextAreaElement,
  workspaceId: string,
  text: string
): Promise<void> {
  const composer = await waitFor(
    () => {
      const el = getComposer();
      if (el.disabled) throw new Error("Composer disabled");
      return el;
    },
    { timeout: 10_000 }
  );
  composer.focus();
  act(() => {
    getDraftStore().setText({ kind: "workspace", workspaceId }, text);
  });
  await waitFor(() => expect(composer.value).toBe(text), { timeout: 5_000 });
  const sendButton = await waitFor(
    () => {
      const button = composer
        .closest('[data-component="ChatInputSection"]')
        ?.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
      if (button == null || button.disabled) throw new Error("Send button not ready");
      return button;
    },
    { timeout: 10_000 }
  );
  fireEvent.click(sendButton);
}

/** Await the first side chat created by a test (tests with multiple chats list them explicitly). */
async function waitForSideChatId(app: AppHarness): Promise<string> {
  return waitFor(
    async () => {
      const sideChats = (await app.env.orpc.workspace.list()).filter(
        (ws) => ws.sideChatParentWorkspaceId === app.workspaceId
      );
      expect(sideChats).toHaveLength(1);
      return sideChats[0].id;
    },
    { timeout: 10_000 }
  );
}

function isStreaming(workspaceId: string): boolean {
  const state = workspaceStore.getWorkspaceSidebarState(workspaceId);
  return state.canInterrupt;
}

/** A pane's transcript scroller: focusable and not editable, so Esc reaches the window listeners. */
function getTranscript(app: AppHarness, pane: "main" | "side"): HTMLElement {
  const transcript = Array.from(
    app.view.container.querySelectorAll<HTMLElement>('[data-testid="message-window"]')
  ).find((el) => (el.closest(SIDE_PANE_SELECTOR) != null) === (pane === "side"));
  if (transcript == null) throw new Error(`${pane} transcript not found`);
  return transcript;
}

function pressEscapeOn(element: HTMLElement): void {
  element.focus();
  expect(document.activeElement).toBe(element);
  fireEvent.keyDown(element, { key: "Escape" });
}

describe("/side chat tab in the right sidebar (mock AI router)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("opens next to the main chat, stays out of the workspace list, and closing discards it", async () => {
    const app = await createAppHarness({ branchPrefix: "side-chat-tab" });
    try {
      const mainPrompt = "Main chat question";
      const sideQuestion = "Side question about it";
      await app.chat.send(mainPrompt);
      await app.chat.expectTranscriptContains(`Mock response: ${mainPrompt}`);
      await app.chat.expectStreamComplete();

      await sendFrom(() => getMainComposer(app), app.workspaceId, "/side");
      const sideChatId = await waitForSideChatId(app);
      await waitFor(() => expect(getSideComposer(app).value).toBe(""));
      expect(isStreaming(sideChatId)).toBe(false);
      expect(await app.env.orpc.workspace.getInfo({ workspaceId: sideChatId })).toMatchObject({
        pendingAutoTitle: true,
      });
      await sendFrom(() => getSideComposer(app), sideChatId, sideQuestion);

      // The side pane streams the inherited history plus its own turn while the main chat
      // remains the routed workspace.
      await waitFor(
        () => {
          const sideText = getSidePane(app)?.textContent ?? "";
          expect(sideText).toContain(mainPrompt);
          expect(sideText).toContain(`Mock response: ${mainPrompt}`);
          expect(sideText).toContain(sideQuestion);
          expect(sideText).toContain(`Mock response: ${sideQuestion}`);
        },
        { timeout: 30_000 }
      );
      expect(decodeURIComponent(window.location.pathname)).toBe(`/workspace/${app.workspaceId}`);
      // Titles are live metadata, not a fixed "Side chat" label or the main chat's title.
      const title = "Understanding the cache behavior";
      await app.env.orpc.workspace.updateTitle({ workspaceId: sideChatId, title });
      await waitFor(() => {
        expect(
          app.view.container.querySelector(`[role="tab"][id$="-tab-side:${sideChatId}"]`)
            ?.textContent
        ).toContain(title);
      });

      // Both chats are on screen: the main transcript (without the side turn) and two composers.
      const mainTranscript = Array.from(
        app.view.container.querySelectorAll('[data-testid="message-window"]')
      ).find((el) => el.closest(SIDE_PANE_SELECTOR) == null);
      expect(mainTranscript?.textContent).toContain(`Mock response: ${mainPrompt}`);
      expect(mainTranscript?.textContent).not.toContain(sideQuestion);
      expect(app.view.container.querySelectorAll(COMPOSER_SELECTOR)).toHaveLength(2);
      getMainComposer(app);
      getSideComposer(app);

      // The workspace list shows the main chat but not its side chat.
      expect(
        app.view.container.querySelector(`[data-workspace-id="${app.workspaceId}"]`)
      ).not.toBeNull();
      expect(app.view.container.querySelector(`[data-workspace-id="${sideChatId}"]`)).toBeNull();

      // Closing the tab removes it and discards the side chat in the backend.
      const closeButton = app.view.container.querySelector<HTMLButtonElement>(
        'button[aria-label="Close side chat"]'
      );
      expect(closeButton).not.toBeNull();
      fireEvent.click(closeButton!);
      await waitFor(() => {
        expect(getSidePane(app)).toBeNull();
        expect(app.view.container.querySelector('button[aria-label="Close side chat"]')).toBeNull();
      });
      await waitFor(
        async () => {
          expect(await app.env.orpc.workspace.getInfo({ workspaceId: sideChatId })).toBeNull();
        },
        { timeout: 10_000 }
      );
      expect(await app.env.orpc.workspace.getInfo({ workspaceId: app.workspaceId })).not.toBeNull();
      expect(app.view.container.querySelectorAll(COMPOSER_SELECTOR)).toHaveLength(1);
    } finally {
      await app.dispose();
    }
  }, 90_000);

  test("opening a side chat during a parent stream never resumes the inherited turn", async () => {
    const app = await createAppHarness({ branchPrefix: "side-inert-stream-snapshot" });
    const context = app.env.services.toORPCContext();
    const service = context.workspaceService;
    const store = useWorkspaceStoreRaw();
    const modelCalls = jest.spyOn(app.env.services.aiService, "streamMessage");
    let sideId: string | undefined;
    let observingStartup = true;
    let parentDeltas = 0;
    const parentStops: string[] = [];
    const sideStartupSymptoms = new Set<string>();
    const sideStarts: string[] = [];

    // Observe before creating the side chat: checking just its final DOM misses the brief
    // interrupted banner between initial replay and the unintended automatic continuation.
    const captureSideState = () => {
      if (!observingStartup || !sideId || !store.getAggregator(sideId)) return;
      const state = store.getWorkspaceState(sideId);
      if (state.canInterrupt || state.isStreamStarting) sideStartupSymptoms.add("active stream");
      const barrier = getRetryBarrierDerivation({
        messages: state.messages,
        renderedMessages: state.messages,
        pendingStreamStartTime: state.pendingStreamStartTime,
        runtimeStatus: state.runtimeStatus,
        lastAbortReason: state.lastAbortReason,
        autoRetryStatus: state.autoRetryStatus,
        isHydratingTranscript: state.isHydratingTranscript,
        isTurnActive: state.canInterrupt || state.isStreamStarting,
        transcriptOnly: false,
      });
      if (
        barrier.showRetryBarrierUI ||
        barrier.interruptedTailResumable ||
        barrier.interruptedBarrierMessageIds.size > 0
      ) {
        sideStartupSymptoms.add("interrupted barrier");
      }
    };
    const onMetadata = (event: {
      workspaceId: string;
      metadata: FrontendWorkspaceMetadata | null;
    }) => {
      if (event.metadata?.sideChatParentWorkspaceId === app.workspaceId) sideId = event.workspaceId;
    };
    const onChat = (event: { workspaceId: string; message: WorkspaceChatMessage }) => {
      if (!("type" in event.message)) return;
      const type = event.message.type;
      if (event.workspaceId === app.workspaceId) {
        if (type === "stream-delta") parentDeltas += 1;
        if (type === "stream-abort" || type === "stream-error") parentStops.push(type);
      } else {
        if (type === "stream-start") sideStarts.push(event.workspaceId);
        if (
          observingStartup &&
          (type === "stream-start" ||
            type === "auto-retry-scheduled" ||
            type === "auto-retry-starting")
        ) {
          sideStartupSymptoms.add(type);
        }
      }
    };
    service.on("metadata", onMetadata);
    service.on("chat", onChat);
    const unsubscribe = store.subscribe(captureSideState);
    const observer = new MutationObserver(() => {
      if (!observingStartup) return;
      const pane = getSidePane(app);
      if (
        pane?.textContent?.includes("Stream interrupted") ||
        pane?.querySelector('[aria-label="Continue interrupted response"]')
      ) {
        sideStartupSymptoms.add("visible interrupted barrier");
      }
    });
    observer.observe(app.view.container, { childList: true, subtree: true, characterData: true });

    try {
      const mainPrompt = "[mock:long-stream] Continue working in the main chat";
      await app.chat.send(mainPrompt);
      await waitFor(() => expect(isStreaming(app.workspaceId)).toBe(true));
      const parentPartial = await waitFor(
        async () => {
          const partial = await context.historyService.readPartial(app.workspaceId);
          if (!partial?.parts.some((part) => part.type === "text" && part.text.length > 0)) {
            throw new Error("waiting for a real in-flight assistant partial");
          }
          return partial;
        },
        { timeout: 10_000 }
      );
      const deltasBeforeOpen = parentDeltas;

      await sendFrom(() => getMainComposer(app), app.workspaceId, "/side");
      const childId = await waitForSideChatId(app);
      await waitFor(() => expect(workspaceStore.isWorkspaceTranscriptCaughtUp(childId)).toBe(true));
      // Join the actual recovery pass scheduled by onChat, not a grace-period sleep. A regression
      // that merely hides the banner still fails on a scheduled retry or automatic model send.
      await act(async () => {
        await service.getOrCreateSession(childId).ensureStartupAutoRetryCheck();
      });
      captureSideState();
      await waitFor(() => expect(parentDeltas).toBeGreaterThan(deltasBeforeOpen));
      expect(isStreaming(app.workspaceId)).toBe(true);
      expect(parentStops).toEqual([]);
      expect((await context.historyService.readPartial(app.workspaceId))?.id).toBe(
        parentPartial.id
      );
      expect(sideStartupSymptoms).toEqual(new Set());
      expect(sideStarts).toEqual([]);
      expect(service.getOrCreateSession(childId).hasPendingAutoRetry()).toBe(false);
      expect(
        modelCalls.mock.calls.filter(([options]) => options.workspaceId === childId)
      ).toHaveLength(0);
      expect(getSidePane(app)?.textContent).toContain(mainPrompt);
      expect(isStreaming(childId)).toBe(false);

      // Only an explicit question starts this independent conversation. It remains a side chat,
      // which is the backend's read-only capability boundary, while the parent keeps streaming.
      observingStartup = false;
      const question = "Explain this context without continuing the main task";
      await sendFrom(() => getSideComposer(app), childId, question);
      await waitFor(
        () => expect(getSidePane(app)?.textContent).toContain(`Mock response: ${question}`),
        { timeout: 30_000 }
      );
      await waitFor(() => expect(isStreaming(childId)).toBe(false));
      expect(sideStarts).toEqual([childId]);
      expect(
        modelCalls.mock.calls.filter(([options]) => options.workspaceId === childId)
      ).toHaveLength(1);
      expect(
        (await app.env.orpc.workspace.getInfo({ workspaceId: childId }))?.sideChatParentWorkspaceId
      ).toBe(app.workspaceId);
      expect(getTranscript(app, "main").textContent).not.toContain(question);
      expect(isStreaming(app.workspaceId)).toBe(true);
      expect(parentStops).toEqual([]);
    } finally {
      observingStartup = false;
      observer.disconnect();
      unsubscribe();
      service.off("metadata", onMetadata);
      service.off("chat", onChat);
      modelCalls.mockRestore();
      await app.dispose();
    }
  }, 90_000);

  test("a failed or rejected discard keeps the side tab available for retry", async () => {
    const app = await createAppHarness({ branchPrefix: "side-close-retry" });
    const service = app.env.services.toORPCContext().workspaceService;
    const remove = jest.spyOn(service, "remove");
    try {
      await sendFrom(() => getMainComposer(app), app.workspaceId, "/side");
      const id = await waitForSideChatId(app);
      const closeButton = await waitFor(() => {
        const button = app.view.container.querySelector<HTMLButtonElement>(
          'button[aria-label="Close side chat"]'
        );
        if (!button) throw new Error("side tab not ready");
        return button;
      });
      remove.mockResolvedValueOnce({ success: false, error: "Keep this tab for retry" });
      fireEvent.click(closeButton);
      await waitFor(() =>
        expect(app.view.container.textContent).toContain("Keep this tab for retry")
      );
      expect(app.view.container.contains(closeButton)).toBe(true);
      expect(await app.env.orpc.workspace.getInfo({ workspaceId: id })).not.toBeNull();

      remove.mockRejectedValueOnce(new Error("Retry after connection failure"));
      fireEvent.click(closeButton);
      await waitFor(() =>
        expect(app.view.container.textContent).toContain("Retry after connection failure")
      );
      expect(app.view.container.contains(closeButton)).toBe(true);

      // Successful retry is the only path that removes the still-reachable tab.
      fireEvent.click(closeButton);
      await waitFor(() => expect(app.view.container.contains(closeButton)).toBe(false));
      expect(await app.env.orpc.workspace.getInfo({ workspaceId: id })).toBeNull();
    } finally {
      remove.mockRestore();
      await app.dispose();
    }
  }, 90_000);

  test("corrupt side tabs never force-delete an ordinary workspace", async () => {
    let remove: jest.SpyInstance | undefined;
    const app = await createAppHarness({
      branchPrefix: "side-invalid-target",
      beforeRenderEnvironment: (env) => {
        remove = jest.spyOn(env.services.toORPCContext().workspaceService, "remove");
      },
      beforeRender: (workspaceId) => {
        // A persisted side:<id> referencing its own ordinary parent is not a side chat.
        updatePersistedState(getRightSidebarLayoutKey(workspaceId), {
          version: 1,
          nextId: 2,
          focusedTabsetId: "tabset-1",
          root: {
            type: "tabset",
            id: "tabset-1",
            tabs: ["costs", `side:${workspaceId}`],
            activeTab: "costs",
          },
        });
      },
    });
    try {
      await waitFor(() => {
        const layout = readPersistedState<RightSidebarLayoutState | null>(
          getRightSidebarLayoutKey(app.workspaceId),
          null
        );
        expect(layout && collectAllTabs(layout.root)).not.toContain(`side:${app.workspaceId}`);
      });
      expect(remove).not.toHaveBeenCalled();
      expect(await app.env.orpc.workspace.getInfo({ workspaceId: app.workspaceId })).not.toBeNull();
    } finally {
      remove?.mockRestore();
      await app.dispose();
    }
  }, 90_000);

  test("opening another side chat keeps the previous chat's tab", async () => {
    const app = await createAppHarness({ branchPrefix: "multiple-side-tabs" });
    try {
      await sendFrom(() => getMainComposer(app), app.workspaceId, "/side");
      const firstId = await waitForSideChatId(app);
      await sendFrom(() => getMainComposer(app), app.workspaceId, "/side");
      const ids = await waitFor(async () => {
        const sideChats = (await app.env.orpc.workspace.list()).filter(
          (metadata) => metadata.sideChatParentWorkspaceId === app.workspaceId
        );
        expect(sideChats).toHaveLength(2);
        return sideChats.map((metadata) => metadata.id);
      });
      expect(ids).toContain(firstId);
      await waitFor(() => {
        for (const id of ids) {
          expect(
            app.view.container.querySelector(`[role="tab"][id$="-tab-side:${id}"]`)
          ).not.toBeNull();
        }
      });
    } finally {
      await app.dispose();
    }
  }, 90_000);

  // Esc is a window-level shortcut that both mounted chat panes listen for; only the pane that
  // holds focus may act on it. Focus sits on each pane's transcript, not a composer (which handles
  // Esc itself), so the window listeners' pane scoping is what decides which chat stops.
  test("Escape interrupts only the chat pane that has focus", async () => {
    const app = await createAppHarness({ branchPrefix: "side-chat-esc" });
    const workspaceService = app.env.services.toORPCContext().workspaceService;
    const interruptSpy = jest.spyOn(workspaceService, "interruptStream");
    const interruptedIds = () => [...new Set(interruptSpy.mock.calls.map((call) => call[0]))];
    try {
      const startStream = async (pane: "main" | "side", workspaceId: string, text: string) => {
        const getComposer = () => (pane === "main" ? getMainComposer(app) : getSideComposer(app));
        await sendFrom(getComposer, workspaceId, text);
        await waitFor(() => expect(isStreaming(workspaceId)).toBe(true), { timeout: 30_000 });
      };
      const stopViaApi = async (workspaceId: string) => {
        await app.env.orpc.workspace.interruptStream({ workspaceId });
        await waitFor(() => expect(isStreaming(workspaceId)).toBe(false), { timeout: 10_000 });
      };

      // Stream order matters for detecting a double-fire: each pane's Esc listener re-registers
      // when its stream starts, and the first listener to stop a stream claims the event
      // (preventDefault). Starting the focused pane's stream last puts the OTHER pane's listener
      // first, so a listener that ignored focus would stop the wrong chat.
      await sendFrom(() => getMainComposer(app), app.workspaceId, "/side");
      const sideChatId = await waitForSideChatId(app);
      await waitFor(() => expect(getSidePane(app)).not.toBeNull());
      await startStream("side", sideChatId, "[mock:long-stream] side stream");
      await startStream("main", app.workspaceId, "[mock:long-stream] main stream");

      // Focus in the main transcript: only the main chat stops.
      interruptSpy.mockClear();
      pressEscapeOn(getTranscript(app, "main"));
      await waitFor(() => expect(interruptSpy).toHaveBeenCalled(), { timeout: 10_000 });
      expect(interruptedIds()).toEqual([app.workspaceId]);
      await waitFor(() => expect(isStreaming(app.workspaceId)).toBe(false), { timeout: 10_000 });
      expect(isStreaming(sideChatId)).toBe(true);

      // Restart both, side last; focus in the side transcript: only the side chat stops.
      await stopViaApi(sideChatId);
      await startStream("main", app.workspaceId, "[mock:long-stream] main again");
      await startStream("side", sideChatId, "[mock:long-stream] side again");
      interruptSpy.mockClear();
      pressEscapeOn(getTranscript(app, "side"));
      await waitFor(() => expect(interruptSpy).toHaveBeenCalled(), { timeout: 10_000 });
      expect(interruptedIds()).toEqual([sideChatId]);
      await waitFor(() => expect(isStreaming(sideChatId)).toBe(false), { timeout: 10_000 });
      expect(isStreaming(app.workspaceId)).toBe(true);
    } finally {
      interruptSpy.mockRestore();
      await app.dispose();
    }
  }, 90_000);
});
