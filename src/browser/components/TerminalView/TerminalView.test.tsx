import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createTestApiClient } from "@/browser/testUtils";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import type { ReactNode } from "react";
import { APIProvider } from "@/browser/contexts/API";
import * as RealGhosttyModule from "ghostty-web";
import * as RealTerminalRouterContextModule from "@/browser/terminal/TerminalRouterContext";
import { restoreModulesAfterSuite } from "../../../../tests/ui/moduleMocks";

interface TerminalSubscribeCallbacks {
  onOutput: (data: string) => void;
  onScreenState: (state: string) => void;
  onExit: (code: number) => void;
}

interface MockTerminalOptions {
  fontSize: number;
  fontFamily: string;
  cursorBlink: boolean;
  theme: {
    background: string;
    foreground: string;
  };
}

interface MockRouter {
  subscribe: ReturnType<
    typeof mock<(sessionId: string, callbacks: TerminalSubscribeCallbacks) => () => void>
  >;
  resize: ReturnType<typeof mock<(sessionId: string, cols: number, rows: number) => Promise<void>>>;
  sendInput: ReturnType<typeof mock<(sessionId: string, data: string) => void>>;
}

let cleanupDom: (() => void) | null = null;
let mockRouter: MockRouter;
let subscribeCallbacks: TerminalSubscribeCallbacks[] = [];
let terminalInstances: MockTerminal[] = [];
let unsubscribeMock: ReturnType<typeof mock<() => void>>;

const initMock = mock(() => Promise.resolve());
const terminalOnExitMock = mock(
  (_input: { sessionId: string }, _options?: { signal?: AbortSignal }) =>
    Promise.resolve(
      (async function* (): AsyncGenerator<number, void, unknown> {
        await Promise.resolve();
        yield* [];
      })()
    )
);

class MockTerminal {
  cols = 80;
  rows = 24;
  options: MockTerminalOptions;
  clear = mock(() => undefined);
  write = mock((_data: string) => undefined);
  resize = mock((cols: number, rows: number) => {
    this.cols = cols;
    this.rows = rows;
  });
  blur = mock(() => undefined);
  focus = mock(() => undefined);
  dispose = mock(() => undefined);

  constructor(options: MockTerminalOptions) {
    this.options = options;
    terminalInstances.push(this);
  }

  loadAddon = mock((_addon: unknown) => undefined);

  open(container: HTMLElement): void {
    container.append(document.createElement("textarea"));
  }

  attachCustomKeyEventHandler = mock((_handler: (ev: KeyboardEvent) => boolean) => undefined);

  paste = mock((_text: string) => undefined);

  hasSelection(): boolean {
    return false;
  }

  getSelection(): string {
    return "";
  }

  onData(_callback: (data: string) => void): { dispose: () => void } {
    return { dispose: mock(() => undefined) };
  }

  onTitleChange(_callback: (title: string) => void): { dispose: () => void } {
    return { dispose: mock(() => undefined) };
  }
}

class MockFitAddon {
  fit = mock(() => undefined);
  proposeDimensions = mock(() => ({ cols: 80, rows: 24 }));
}

// Restore the real modules after this suite so the stubs below cannot leak into later files.
restoreModulesAfterSuite([
  ["ghostty-web", { ...RealGhosttyModule }],
  ["@/browser/terminal/TerminalRouterContext", { ...RealTerminalRouterContextModule }],
]);
void mock.module("ghostty-web", () => ({
  init: initMock,
  Terminal: MockTerminal,
  FitAddon: MockFitAddon,
}));

void mock.module("@/browser/terminal/TerminalRouterContext", () => ({
  useTerminalRouter: () => mockRouter,
}));

import { TerminalView } from "./TerminalView";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
import { DEFAULT_TERMINAL_BADGE_CONFIG } from "@/common/constants/storage";

function createRouter(): MockRouter {
  unsubscribeMock = mock(() => undefined);
  return {
    subscribe: mock((sessionId: string, callbacks: TerminalSubscribeCallbacks) => {
      expect(sessionId).toBe("terminal-1");
      subscribeCallbacks.push(callbacks);
      callbacks.onScreenState("initial screen");
      return unsubscribeMock;
    }),
    resize: mock((_sessionId: string, _cols: number, _rows: number) => Promise.resolve()),
    sendInput: mock((_sessionId: string, _data: string) => undefined),
  };
}

// Inject the client through the real provider; mocking the API module leaks process-wide
// into later suites.
const apiClient = createTestApiClient({
  terminal: {
    onExit: terminalOnExitMock,
  },
});

function APIWrapper(props: { children: ReactNode }) {
  return <APIProvider client={apiClient}>{props.children}</APIProvider>;
}

function renderTerminal(onExit: (exitCode: number) => void) {
  return render(
    <TerminalView
      workspaceId="workspace-1"
      sessionId="terminal-1"
      visible
      setDocumentTitle={false}
      autoFocus={false}
      onExit={onExit}
    />,
    { wrapper: APIWrapper }
  );
}

describe("TerminalView", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    mockRouter = createRouter();
    subscribeCallbacks = [];
    terminalInstances = [];
  });

  afterEach(() => {
    cleanup();
    getAppConfigStore().updateOptimistically({ userPreferences: undefined });
    cleanupDom?.();
    cleanupDom = null;
    mock.restore();
  });

  test("keeps the router subscription stable when onExit changes", async () => {
    const firstOnExit = mock((_exitCode: number) => undefined);
    const secondOnExit = mock((_exitCode: number) => undefined);

    const view = renderTerminal(firstOnExit);

    await waitFor(() => {
      expect(mockRouter.subscribe).toHaveBeenCalledTimes(1);
    });

    const firstSubscription = subscribeCallbacks[0];
    const terminal = terminalInstances[0];
    expect(firstSubscription).toBeDefined();
    expect(terminal).toBeDefined();
    expect(terminal.clear).toHaveBeenCalledTimes(1);

    await act(async () => {
      view.rerender(
        <TerminalView
          workspaceId="workspace-1"
          sessionId="terminal-1"
          visible
          setDocumentTitle={false}
          autoFocus={false}
          onExit={secondOnExit}
        />
      );
      await Promise.resolve();
    });

    expect(mockRouter.subscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribeMock).toHaveBeenCalledTimes(0);
    expect(terminal.clear).toHaveBeenCalledTimes(1);

    firstSubscription.onExit(7);

    expect(firstOnExit).toHaveBeenCalledTimes(0);
    expect(secondOnExit).toHaveBeenCalledTimes(1);
    expect(secondOnExit.mock.calls[0]?.[0]).toBe(7);
  });

  // The container stays visibility:hidden ("Connecting...") until the first screen state, and a
  // browser drops focus from a hidden element, so autofocus must wait for it (T3, #5971).
  test("keeps autofocus pending until the terminal shows its first screen", async () => {
    // The focus path checks `instanceof HTMLTextAreaElement`; installDom does not expose it.
    const previousTextArea = globalThis.HTMLTextAreaElement;
    globalThis.HTMLTextAreaElement = window.HTMLTextAreaElement;
    try {
      mockRouter.subscribe = mock((_sessionId: string, callbacks: TerminalSubscribeCallbacks) => {
        subscribeCallbacks.push(callbacks);
        return unsubscribeMock;
      });
      const onAutoFocusConsumed = mock(() => undefined);
      const view = render(
        <TerminalView
          workspaceId="workspace-1"
          sessionId="terminal-1"
          visible
          setDocumentTitle={false}
          autoFocus
          onAutoFocusConsumed={onAutoFocusConsumed}
        />,
        { wrapper: APIWrapper }
      );

      await waitFor(() => expect(mockRouter.subscribe).toHaveBeenCalledTimes(1));
      // Give the focus retry loop a few frames while the screen is still hidden.
      await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
      expect(onAutoFocusConsumed).not.toHaveBeenCalled();

      act(() => subscribeCallbacks[0].onScreenState(""));

      await waitFor(() => expect(onAutoFocusConsumed).toHaveBeenCalledTimes(1));
      expect(document.activeElement).toBe(view.container.querySelector("textarea"));
    } finally {
      globalThis.HTMLTextAreaElement = previousTextArea;
    }
  });

  test("renders the badge overlay with substituted template when enabled", async () => {
    getAppConfigStore().updateOptimistically({
      userPreferences: {
        appearance: { terminalBadgeConfig: { ...DEFAULT_TERMINAL_BADGE_CONFIG, enabled: true } },
      },
    });

    const view = render(
      <TerminalView
        workspaceId="workspace-1"
        sessionId="terminal-1"
        visible
        setDocumentTitle={false}
        autoFocus={false}
        workspaceName="my-feature"
        projectName="xum"
        tabName="Terminal 2"
      />,
      { wrapper: APIWrapper }
    );

    await waitFor(() => {
      expect(view.container.textContent).toContain("my-feature · Terminal 2");
    });
  });

  test("renders no badge overlay by default", async () => {
    const view = render(
      <TerminalView
        workspaceId="workspace-1"
        sessionId="terminal-1"
        visible
        setDocumentTitle={false}
        autoFocus={false}
        workspaceName="my-feature"
        projectName="xum"
        tabName="Terminal 2"
      />,
      { wrapper: APIWrapper }
    );

    await waitFor(() => {
      expect(mockRouter.subscribe).toHaveBeenCalledTimes(1);
    });
    expect(view.container.textContent).not.toContain("my-feature");
  });
});
