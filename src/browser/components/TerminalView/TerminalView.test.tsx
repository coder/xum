import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createTestApiClient } from "@/browser/testUtils";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import { useState, type ReactNode } from "react";
import { APIProvider, useAPI } from "@/browser/contexts/API";
import * as RealGhosttyModule from "ghostty-web";
import * as RealTerminalRouterContextModule from "@/browser/terminal/TerminalRouterContext";
import { restoreModulesAfterSuite } from "../../../../tests/ui/moduleMocks";
import { createConnectionHarness, GAP_MODES } from "@/browser/contexts/connection.testHarness";

interface TerminalSubscribeCallbacks {
  onOutput: (data: string) => void;
  onScreenState: (state: string, options?: { replace: boolean }) => void;
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
  syncSize: ReturnType<typeof mock<(sessionId: string, cols: number, rows: number) => void>>;
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
  calls: string[] = [];
  clear = mock(() => undefined);
  reset = mock(() => {
    this.calls.push("reset");
  });
  write = mock((data: string) => {
    this.calls.push(`write:${data}`);
  });
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
import { useTerminalSessionSync } from "@/browser/features/RightSidebar/RightSidebar";
import {
  getTerminalSessionId,
  isTerminalTab,
  makeTerminalTabType,
} from "@/browser/types/rightSidebar";
import {
  addTabToFocusedTabset,
  collectAllTabs,
  getDefaultRightSidebarLayoutState,
  removeTabEverywhere,
} from "@/browser/utils/rightSidebarLayout";

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
    syncSize: mock((_sessionId: string, _cols: number, _rows: number) => undefined),
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

  // After a reconnect the router sends the full screen again. Written on top of the old screen,
  // the scrollback would repeat, so a replacing screen starts from an empty terminal.
  test("a screen that replaces the old one is written after a full VT reset", async () => {
    renderTerminal(mock((_exitCode: number) => undefined));
    await waitFor(() => expect(mockRouter.subscribe).toHaveBeenCalledTimes(1));
    const terminal = terminalInstances[0];
    expect(terminal?.calls).toEqual(["write:initial screen"]);

    act(() => subscribeCallbacks[0]?.onScreenState("screen after reconnect", { replace: true }));
    // One write: a full reset (RIS) in the VT, then the screen. Never Terminal.reset(), which
    // frees ghostty's WASM terminal while other parts of ghostty-web still use it.
    expect(terminal?.calls).toEqual(["write:initial screen", "write:\x1bcscreen after reconnect"]);
    expect(terminal?.reset).toHaveBeenCalledTimes(0);
    // The view keeps its one subscription: no new subscribe, no clear.
    expect(mockRouter.subscribe).toHaveBeenCalledTimes(1);
    expect(terminal?.clear).toHaveBeenCalledTimes(1);
  });

  // After the switch the client stays the same while Xum reconnects, so the exit stream fails
  // with ConnectionLostError instead of being aborted by a new client: that is not an exit.
  test.each([...GAP_MODES])("a lost connection does not end the terminal (%s)", async (mode) => {
    let exitSubscriptions = 0;
    const harness = createConnectionHarness(mode, () => ({
      terminal: {
        onExit: () => {
          exitSubscriptions += 1;
          return Promise.resolve(
            (async function* (): AsyncGenerator<number, void, unknown> {
              await new Promise(() => undefined); // the process keeps running
              yield 0;
            })()
          );
        },
      },
    }));
    const onExit = mock((_exitCode: number) => undefined);
    render(
      <TerminalView
        workspaceId="workspace-1"
        sessionId="terminal-1"
        visible
        setDocumentTitle={false}
        autoFocus={false}
        onExit={onExit}
      />,
      { wrapper: harness.Wrapper }
    );
    await waitFor(() => expect(exitSubscriptions).toBe(1));

    await harness.drop();
    harness.reconnect();
    await waitFor(() => expect(exitSubscriptions).toBe(2));
    expect(onExit).not.toHaveBeenCalled();
  });

  // A server restart ends every PTY. The new server lists no sessions and reports exit 0 for
  // each one, and that report can come after the list. The sidebar's session sync must leave the
  // tab to the view's exit path, which writes the exit line before it closes the tab.
  test.each([...GAP_MODES])(
    "after a server restart the exit line is written before the tab closes (%s)",
    async (mode) => {
      let restarted = false;
      let reportExit: () => void = () => undefined;
      const exitReported = new Promise<void>((resolve) => (reportExit = resolve));
      const harness = createConnectionHarness(mode, () => {
        const serverRestarted = restarted;
        return {
          terminal: {
            listSessions: () => Promise.resolve(serverRestarted ? [] : ["terminal-1"]),
            onExit: () =>
              Promise.resolve(
                (async function* (): AsyncGenerator<number, void, unknown> {
                  // Before the restart the process keeps running.
                  await (serverRestarted ? exitReported : new Promise(() => undefined));
                  yield 0;
                })()
              ),
          },
        };
      });

      // The sidebar's terminal part: the session sync, and a view per tab that closes it on exit.
      function Sidebar() {
        const { api } = useAPI();
        const [layout, setLayout] = useState(() =>
          addTabToFocusedTabset(
            getDefaultRightSidebarLayoutState(),
            makeTerminalTabType("terminal-1")
          )
        );
        useTerminalSessionSync(api, "workspace-1", layout, setLayout);
        return collectAllTabs(layout.root)
          .filter(isTerminalTab)
          .map((tab) => (
            <div key={tab} data-testid={tab}>
              <TerminalView
                workspaceId="workspace-1"
                sessionId={getTerminalSessionId(tab) ?? ""}
                visible
                setDocumentTitle={false}
                autoFocus={false}
                onExit={() => setLayout((prev) => removeTabEverywhere(prev, tab))}
              />
            </div>
          ));
      }
      const view = render(<Sidebar />, { wrapper: harness.Wrapper });
      await waitFor(() => expect(terminalInstances).toHaveLength(1));
      const terminal = terminalInstances[0];

      await harness.drop();
      restarted = true;
      harness.reconnect();
      // Let the new server's session list arrive before its exit report.
      await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
      reportExit();

      await waitFor(() =>
        expect(terminal?.calls).toContain("write:\r\n[Process exited with code 0]\r\n")
      );
      await waitFor(() => expect(view.queryByTestId("terminal:terminal-1")).toBeNull());
    }
  );

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
