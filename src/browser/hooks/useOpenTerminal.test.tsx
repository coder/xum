import "../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import type { ReactNode } from "react";
import { APIProvider } from "@/browser/contexts/API";
import { createTestApiClient } from "@/browser/testUtils";
import { hideTerminalDialog, useTerminalDialogSession } from "@/browser/utils/terminalDialogStore";
import { CUSTOM_EVENTS, type CustomEventPayloads } from "@/common/constants/events";
import { useOpenTerminal } from "./useOpenTerminal";

type ToastPayload = CustomEventPayloads[typeof CUSTOM_EVENTS.ANALYTICS_REBUILD_TOAST];

describe("useOpenTerminal in browser mode (#5684)", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let toasts: ToastPayload[];

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    globalThis.window = new GlobalWindow({ url: "http://localhost" }) as unknown as Window &
      typeof globalThis;
    globalThis.document = globalThis.window.document;
    const host = document.createElement("div");
    host.setAttribute("data-component", "ChatInputSection");
    document.body.appendChild(host);
    toasts = [];
    window.addEventListener(CUSTOM_EVENTS.ANALYTICS_REBUILD_TOAST, (event) => {
      toasts.push((event as CustomEvent<ToastPayload>).detail);
    });
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  function renderOpenTerminal() {
    const create = mock((_input: { workspaceId: string }) =>
      Promise.resolve({ sessionId: "session-1", workspaceId: "ws-1", cols: 80, rows: 24 })
    );
    const openWindow = mock((_input: { workspaceId: string; sessionId?: string }) =>
      Promise.resolve()
    );
    const close = mock((_input: { sessionId: string }) => Promise.resolve());
    const client = createTestApiClient({ terminal: { create, openWindow, close } });
    const wrapper = (props: { children: ReactNode }) => (
      <APIProvider client={client}>{props.children}</APIProvider>
    );
    const { result } = renderHook(() => useOpenTerminal(), { wrapper });
    return { result, create, openWindow, close };
  }

  test("a blocked popup shows an error toast and closes the session nobody will attach to", async () => {
    window.open = () => null;
    const { result, close, openWindow } = renderOpenTerminal();

    await act(() => result.current("ws-1"));

    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ type: "error" });
    expect(toasts[0].message.toLowerCase()).toContain("pop-up");
    expect(close.mock.calls).toEqual([[{ sessionId: "session-1" }]]);
    expect(openWindow).not.toHaveBeenCalled();
  });

  test("an opened popup keeps its session and shows no toast", async () => {
    window.open = (() => ({})) as unknown as typeof window.open;
    const { result, close, openWindow } = renderOpenTerminal();

    await act(() => result.current("ws-1"));

    expect(toasts).toHaveLength(0);
    expect(close).not.toHaveBeenCalled();
    expect(openWindow).toHaveBeenCalledTimes(1);
  });

  describe("in an iOS Home Screen web app", () => {
    let standaloneDescriptor: PropertyDescriptor | undefined;
    let windowOpen: ReturnType<typeof mock>;

    beforeEach(() => {
      standaloneDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, "standalone");
      Object.defineProperty(globalThis.navigator, "standalone", {
        configurable: true,
        value: true,
      });
      windowOpen = mock(() => null);
      window.open = windowOpen as unknown as typeof window.open;
    });

    afterEach(() => {
      // Unmount the dialog hook first, so hiding the session does not re-render it outside act.
      cleanup();
      hideTerminalDialog("session-1");
      if (standaloneDescriptor) {
        Object.defineProperty(globalThis.navigator, "standalone", standaloneDescriptor);
      } else {
        Reflect.deleteProperty(globalThis.navigator, "standalone");
      }
    });

    // iOS showed terminal.html in place of the app, with no way back to it.
    test("shows the terminal in the in-app dialog instead of opening a window", async () => {
      const { result, close, openWindow } = renderOpenTerminal();
      const dialog = renderHook(() => useTerminalDialogSession());

      await act(() => result.current("ws-1"));

      expect(windowOpen).not.toHaveBeenCalled();
      expect(openWindow).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(toasts).toHaveLength(0);
      expect(dialog.result.current).toEqual({ workspaceId: "ws-1", sessionId: "session-1" });
    });

    // A toast would render behind the dialog, so it only showed up, stale, after closing it.
    test("a second terminal while the dialog shows one closes only the new session, without a toast", async () => {
      const { result, create, close } = renderOpenTerminal();
      const dialog = renderHook(() => useTerminalDialogSession());
      await act(() => result.current("ws-1"));
      create.mockImplementationOnce(() =>
        Promise.resolve({ sessionId: "session-2", workspaceId: "ws-1", cols: 80, rows: 24 })
      );

      await act(() => result.current("ws-1"));

      expect(dialog.result.current?.sessionId).toBe("session-1");
      expect(close.mock.calls).toEqual([[{ sessionId: "session-2" }]]);
      expect(toasts).toHaveLength(0);
    });
  });
});
