import type { ReactNode, RefObject } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import type { ChatInputAPI } from "@/browser/features/ChatInput";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { createTestApiClient, type TestApiOverrides } from "@/browser/testUtils";
import { useAIViewKeybinds } from "./useAIViewKeybinds";
import { useEscapeToDismiss } from "./useEscapeToDismiss";

let originalWindow: typeof globalThis.window;
let originalDocument: typeof globalThis.document;
let originalHTMLElement: unknown;

// The app mounts the stream-interrupt listener (ChatPane) before an overlay opens, so this
// harness registers it first too: the order decides which window listener sees Escape first.
function renderWithStreamInterrupt(overlayOpen: boolean) {
  const interruptStream = mock(() => Promise.resolve({ success: true as const, data: undefined }));
  const client: TestApiOverrides<APIClient> = { workspace: { interruptStream } };
  const onDismiss = mock(() => undefined);
  const chatInputAPI: RefObject<ChatInputAPI | null> = { current: null };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <APIProvider client={createTestApiClient(client)}>{children}</APIProvider>
  );
  renderHook(
    () => {
      useAIViewKeybinds({
        workspaceId: "ws",
        canInterrupt: true,
        showRetryBarrier: false,
        chatInputAPI,
        jumpToBottom: () => undefined,
        loadOlderHistory: null,
        handleOpenTerminal: () => undefined,
        handleOpenInEditor: () => undefined,
        aggregator: undefined,
        setEditingMessage: () => undefined,
        vimEnabled: false,
      });
      useEscapeToDismiss(overlayOpen, onDismiss);
    },
    { wrapper }
  );
  return { interruptStream, onDismiss };
}

function pressEscape(target: EventTarget, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new window.KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

function addComposer(): HTMLTextAreaElement {
  const composer = document.createElement("textarea");
  document.body.appendChild(composer);
  composer.focus();
  return composer;
}

describe("useEscapeToDismiss", () => {
  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalHTMLElement = (globalThis as unknown as { HTMLElement: unknown }).HTMLElement;
    const domWindow = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.window = domWindow;
    globalThis.document = domWindow.document;
    // The keybind helpers check `target instanceof HTMLElement`.
    (globalThis as unknown as { HTMLElement: unknown }).HTMLElement = domWindow.HTMLElement;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    (globalThis as unknown as { HTMLElement: unknown }).HTMLElement = originalHTMLElement;
  });

  test("with the overlay closed, Escape interrupts the stream exactly as before", async () => {
    const { interruptStream, onDismiss } = renderWithStreamInterrupt(false);

    // The composer ignores Escape for the interrupt unless it opts in, and nothing claims it.
    const fromComposer = pressEscape(addComposer());
    expect(fromComposer.defaultPrevented).toBe(false);
    expect(interruptStream).not.toHaveBeenCalled();

    // Outside an editable element, Escape still interrupts.
    pressEscape(document.body);
    await waitFor(() => expect(interruptStream).toHaveBeenCalledTimes(1));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  test("with the overlay open, Escape from the composer closes it and interrupts nothing", () => {
    const { interruptStream, onDismiss } = renderWithStreamInterrupt(true);

    const event = pressEscape(addComposer());

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(interruptStream).not.toHaveBeenCalled();
  });

  test("with the overlay open, Escape from targets the interrupt accepts closes it and interrupts nothing", async () => {
    const { interruptStream, onDismiss } = renderWithStreamInterrupt(true);
    const optedIn = addComposer();
    optedIn.setAttribute("data-escape-interrupts-stream", "");

    pressEscape(document.body);
    pressEscape(optedIn);

    expect(onDismiss).toHaveBeenCalledTimes(2);
    // stopStream runs asynchronously, so give a wrongly started interrupt time to arrive.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(interruptStream).not.toHaveBeenCalled();
  });

  test("one Escape closes only the most recently opened overlay", () => {
    const drawer = mock(() => undefined);
    const tutorial = mock(() => undefined);
    const view = renderHook(
      (props: { tutorialOpen: boolean }) => {
        useEscapeToDismiss(true, drawer);
        useEscapeToDismiss(props.tutorialOpen, tutorial);
      },
      { initialProps: { tutorialOpen: false } }
    );
    // The tutorial opens over the already open drawer.
    view.rerender({ tutorialOpen: true });

    pressEscape(document.body);
    expect(tutorial).toHaveBeenCalledTimes(1);
    expect(drawer).not.toHaveBeenCalled();

    view.rerender({ tutorialOpen: false });
    pressEscape(document.body);
    expect(drawer).toHaveBeenCalledTimes(1);
    expect(tutorial).toHaveBeenCalledTimes(1);
  });

  test("leaves Escape to whatever already handled it", () => {
    const { onDismiss } = renderWithStreamInterrupt(true);
    const composer = addComposer();

    // An open popover, menu or edit mode: they call preventDefault or stop propagation.
    const claim = (e: Event) => e.preventDefault();
    document.addEventListener("keydown", claim);
    pressEscape(composer);
    document.removeEventListener("keydown", claim);
    const stop = (e: Event) => e.stopPropagation();
    document.addEventListener("keydown", stop);
    pressEscape(composer);
    document.removeEventListener("keydown", stop);

    // IME composition, modified Escape, a terminal, and an open modal dialog.
    pressEscape(composer, { isComposing: true });
    pressEscape(composer, { ctrlKey: true, shiftKey: true });
    const terminal = document.createElement("div");
    terminal.setAttribute("data-terminal-container", "");
    document.body.appendChild(terminal);
    pressEscape(terminal);
    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
    pressEscape(composer);

    expect(onDismiss).not.toHaveBeenCalled();
  });
});
