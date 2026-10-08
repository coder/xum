/**
 * /side opens the side chat as a "Side chat" tab in the right sidebar: a second live chat pane
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
import { workspaceStore } from "@/browser/stores/WorkspaceStore";
import { SIDE_CHAT_PANE_ATTR } from "@/browser/utils/ui/keybinds";

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

/** The side chat the backend registered for this parent (exactly one, by design). */
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

      await sendFrom(() => getMainComposer(app), app.workspaceId, `/side ${sideQuestion}`);
      const sideChatId = await waitForSideChatId(app);

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
      expect(
        app.view.container.querySelector(`[role="tab"][id$="-tab-side:${sideChatId}"]`)
      ).not.toBeNull();

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
      await sendFrom(
        () => getMainComposer(app),
        app.workspaceId,
        "/side [mock:long-stream] side stream"
      );
      const sideChatId = await waitForSideChatId(app);
      await waitFor(() => expect(isStreaming(sideChatId)).toBe(true), { timeout: 30_000 });
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
