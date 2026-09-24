import "../../../../../tests/ui/dom";
import { restoreModulesAfterSuite } from "../../../../../tests/ui/moduleMocks";
import * as RealAPIModule from "@/browser/contexts/API";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import type { ComponentProps } from "react";

interface BrowserControlResponse {
  success: boolean;
  error?: string;
}

const controlMock = mock<() => Promise<BrowserControlResponse>>(() =>
  Promise.resolve({ success: true })
);

// Later full-app suites must not inherit this partial API client.
restoreModulesAfterSuite([["@/browser/contexts/API", { ...RealAPIModule }]]);
void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: {
      browser: {
        control: controlMock,
      },
    },
    status: "connected" as const,
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

import { BrowserToolbar } from "./BrowserToolbar";

function renderToolbar(overrides: Partial<ComponentProps<typeof BrowserToolbar>> = {}) {
  const onSetPendingUrl = mock(() => undefined);

  const view = render(
    <BrowserToolbar
      workspaceId="workspace-1"
      sessionName="session-a"
      currentUrl="https://current.example.com"
      pendingUrl={null}
      isPageLoading={false}
      isConnected={true}
      onSetPendingUrl={onSetPendingUrl}
      {...overrides}
    />
  );

  return { onSetPendingUrl, ...view };
}

function createDeferredPromise<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe("BrowserToolbar", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalSetTimeout: typeof globalThis.setTimeout;
  let originalClearTimeout: typeof globalThis.clearTimeout;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalSetTimeout = globalThis.setTimeout;
    originalClearTimeout = globalThis.clearTimeout;
    globalThis.window = new GlobalWindow({ url: "http://localhost" }) as unknown as Window &
      typeof globalThis;
    globalThis.document = globalThis.window.document;
    controlMock.mockReset();
    controlMock.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });

  test("disables all controls when the bridge is disconnected", () => {
    const view = renderToolbar({ isConnected: false });

    expect((view.getByLabelText("Back") as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByLabelText("Forward") as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByLabelText("Reload") as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByLabelText("Browser URL") as HTMLInputElement).disabled).toBe(true);
  });

  test("disables all controls when no session is selected", () => {
    const view = renderToolbar({ sessionName: null });

    expect((view.getByLabelText("Back") as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByLabelText("Forward") as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByLabelText("Reload") as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByLabelText("Browser URL") as HTMLInputElement).disabled).toBe(true);
  });

  test("shows the current URL when there is no pending navigation", () => {
    const view = renderToolbar({ currentUrl: "https://current.example.com" });

    expect((view.getByLabelText("Browser URL") as HTMLInputElement).value).toBe(
      "https://current.example.com"
    );
  });

  test("shows the pending URL when optimistic navigation is active", () => {
    const view = renderToolbar({ pendingUrl: "https://pending.example.com" });

    expect((view.getByLabelText("Browser URL") as HTMLInputElement).value).toBe(
      "https://pending.example.com"
    );
  });

  test("submits URL navigation on Enter", async () => {
    const { onSetPendingUrl, getByLabelText } = renderToolbar({
      pendingUrl: "https://next.example.com",
    });
    const input = getByLabelText("Browser URL") as HTMLInputElement;

    input.focus();
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSetPendingUrl).toHaveBeenCalledWith("https://next.example.com");
    await waitFor(() => {
      expect(controlMock).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        sessionName: "session-a",
        action: "open",
        url: "https://next.example.com",
      });
    });
  });

  test("preserves file URLs when submitting navigation", async () => {
    const { onSetPendingUrl, getByLabelText } = renderToolbar({
      pendingUrl: "file:///Users/me/report.html",
    });
    const input = getByLabelText("Browser URL") as HTMLInputElement;

    input.focus();
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSetPendingUrl).toHaveBeenCalledWith("file:///Users/me/report.html");
    await waitFor(() => {
      expect(controlMock).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        sessionName: "session-a",
        action: "open",
        url: "file:///Users/me/report.html",
      });
    });
  });

  test("shows open command errors returned by the browser control API", async () => {
    controlMock.mockResolvedValueOnce({ success: false, error: "Navigation failed" });
    const { onSetPendingUrl, getByLabelText, getByText } = renderToolbar({
      pendingUrl: "https://next.example.com",
    });
    const input = getByLabelText("Browser URL") as HTMLInputElement;

    input.focus();
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSetPendingUrl).toHaveBeenCalledWith("https://next.example.com");
    await waitFor(() => {
      expect(controlMock).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        sessionName: "session-a",
        action: "open",
        url: "https://next.example.com",
      });
    });
    await waitFor(() => {
      expect(getByText("Navigation failed")).toBeTruthy();
    });
    expect((getByLabelText("Browser URL") as HTMLInputElement).disabled).toBe(false);
  });

  test("sends back, forward, and reload commands", async () => {
    const view = renderToolbar();

    fireEvent.click(view.getByLabelText("Back"));
    await waitFor(() => {
      expect(controlMock).toHaveBeenNthCalledWith(1, {
        workspaceId: "workspace-1",
        sessionName: "session-a",
        action: "back",
      });
    });

    fireEvent.click(view.getByLabelText("Forward"));
    await waitFor(() => {
      expect(controlMock).toHaveBeenNthCalledWith(2, {
        workspaceId: "workspace-1",
        sessionName: "session-a",
        action: "forward",
      });
    });

    fireEvent.click(view.getByLabelText("Reload"));
    await waitFor(() => {
      expect(controlMock).toHaveBeenNthCalledWith(3, {
        workspaceId: "workspace-1",
        sessionName: "session-a",
        action: "reload",
      });
    });
  });

  test("sends explicit other-workspace scope with browser control commands", async () => {
    const view = renderToolbar({ allowOtherWorkspaceSession: true });

    fireEvent.click(view.getByLabelText("Reload"));

    await waitFor(() => {
      expect(controlMock).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        sessionName: "session-a",
        action: "reload",
        allowOtherWorkspaceSession: true,
      });
    });
  });

  test("runs browser navigation shortcuts when the URL input is not focused", async () => {
    let keyDownHandler: ((event: KeyboardEvent) => void) | null = null;
    const originalAddEventListener = window.addEventListener.bind(window);
    window.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions
    ) => {
      if (type === "keydown" && typeof listener === "function") {
        keyDownHandler = (event: KeyboardEvent) => {
          listener(event);
        };
      }
      return originalAddEventListener(type, listener, options);
    }) as typeof window.addEventListener;

    try {
      renderToolbar();
      expect(keyDownHandler).toBeTruthy();

      await act(async () => {
        keyDownHandler?.(new window.KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true }));
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(controlMock).toHaveBeenNthCalledWith(1, {
          workspaceId: "workspace-1",
          sessionName: "session-a",
          action: "back",
        });
      });

      await act(async () => {
        keyDownHandler?.(new window.KeyboardEvent("keydown", { key: "ArrowRight", altKey: true }));
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(controlMock).toHaveBeenNthCalledWith(2, {
          workspaceId: "workspace-1",
          sessionName: "session-a",
          action: "forward",
        });
      });

      await act(async () => {
        keyDownHandler?.(new window.KeyboardEvent("keydown", { key: "r", ctrlKey: true }));
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(controlMock).toHaveBeenNthCalledWith(3, {
          workspaceId: "workspace-1",
          sessionName: "session-a",
          action: "reload",
        });
      });
    } finally {
      window.addEventListener = originalAddEventListener;
    }
  });

  test("ignores browser navigation shortcuts while the URL input is focused", () => {
    const view = renderToolbar();
    const input = view.getByLabelText("Browser URL") as HTMLInputElement;

    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "r", ctrlKey: true });

    expect(controlMock).not.toHaveBeenCalled();
  });

  test("disables controls while a command is pending", async () => {
    const deferred = createDeferredPromise<{ success: boolean }>();
    controlMock.mockImplementation(() => deferred.promise);
    const view = renderToolbar();
    const reloadButton = view.getByLabelText("Reload") as HTMLButtonElement;
    const input = view.getByLabelText("Browser URL") as HTMLInputElement;

    fireEvent.click(reloadButton);

    await waitFor(() => {
      expect(reloadButton.disabled).toBe(true);
      expect(input.disabled).toBe(true);
    });

    fireEvent.click(reloadButton);
    expect(controlMock).toHaveBeenCalledTimes(1);

    deferred.resolve({ success: true });

    await waitFor(() => {
      expect(reloadButton.disabled).toBe(false);
      expect(input.disabled).toBe(false);
    });
  });

  test("shows control errors with an assertive alert and allows retry after clearing", async () => {
    controlMock.mockRejectedValueOnce(new Error("Reload failed"));
    const view = renderToolbar();

    fireEvent.click(view.getByLabelText("Reload"));

    await waitFor(() => {
      expect(view.getByText("Reload failed")).toBeTruthy();
    });

    const alert = view.getByText("Reload failed");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.getAttribute("aria-live")).toBe("assertive");
    expect(alert.getAttribute("aria-atomic")).toBe("true");
    expect((view.getByLabelText("Browser URL") as HTMLInputElement).disabled).toBe(false);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3100));
    });

    await waitFor(() => {
      expect(view.queryByText("Reload failed")).toBeNull();
    });

    fireEvent.click(view.getByLabelText("Reload"));

    await waitFor(() => {
      expect(controlMock).toHaveBeenCalledTimes(2);
    });
  });

  test("shows a spinning loading icon while the page is loading", () => {
    const view = renderToolbar({ isPageLoading: true });

    expect(view.getByTestId("browser-toolbar-loading-icon")).toBeTruthy();
    expect(view.queryByTestId("browser-toolbar-reload-icon")).toBeNull();
  });

  test("Escape blurs the URL input and keeps stream interruption opt-in enabled", () => {
    const view = renderToolbar();
    const input = view.getByLabelText("Browser URL") as HTMLInputElement;

    expect(input.getAttribute("data-escape-interrupts-stream")).toBe("true");
    act(() => {
      input.focus();
    });
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: "Escape" });

    expect(document.activeElement).not.toBe(input);
  });
});
