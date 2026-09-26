import "../../../../../tests/ui/dom";
import { APIProvider } from "@/browser/contexts/API";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createTestApiClient } from "@/browser/testUtils";
import { GlobalWindow } from "happy-dom";
import type { ReactElement, ReactNode } from "react";

import type {
  BrowserDiscoveredOtherSession,
  BrowserDiscoveredSession,
  BrowserPageTab,
  BrowserSession,
} from "./browserBridgeTypes";

const listSessionsMock = mock(() =>
  Promise.resolve({
    sessions: [] as BrowserDiscoveredSession[],
    otherSessions: [] as BrowserDiscoveredOtherSession[],
  })
);
const listTabsMock = mock(() =>
  Promise.resolve({
    tabs: [] as BrowserPageTab[],
    error: undefined as string | undefined,
  })
);
const selectTabMock = mock(() =>
  Promise.resolve({ success: true, error: undefined as string | undefined })
);
const connectMock = mock(() => undefined);
const disconnectMock = mock(() => undefined);
const sendInputMock = mock(() => undefined);
const setPendingUrlMock = mock(() => undefined);
let mockSession: BrowserSession | null = null;

const apiMock = {
  browser: {
    listTabs: listTabsMock,
    selectTab: selectTabMock,
    listSessions: listSessionsMock,
  },
};
// Inject the client through the real provider: a module mock of contexts/API is process-wide
// and leaks this partial client into later-evaluated suites.
function ApiWrapper(props: { children: ReactNode }) {
  return <APIProvider client={createTestApiClient(apiMock)}>{props.children}</APIProvider>;
}

function renderWithApi(ui: ReactElement) {
  return render(ui, { wrapper: ApiWrapper });
}

// No usePersistedState module mock: each test gets a fresh happy-dom window, so the real
// hook already returns the null default this suite relies on. A module replacement here
// leaks process-wide (bun's mock.module overrides the module cache for every file
// evaluated afterwards), turning later-evaluated suites' persistence into no-ops (seen as
// GeneralSection CI failures once the CommandPalette suite — whose imports used to load
// the real module graph first — moved out of the monolithic pass).

void mock.module("./useBrowserBridgeConnection", () => ({
  useBrowserBridgeConnection: () => ({
    session: mockSession,
    connect: connectMock,
    disconnect: disconnectMock,
    sendInput: sendInputMock,
    setPendingUrl: setPendingUrlMock,
  }),
}));

import {
  BROWSER_PREVIEW_RETRY_INTERVAL_MS,
  BrowserTab,
  chooseExplicitOtherSession,
  shouldBackOffBrowserReconnect,
} from "./BrowserTab";

function createSession(overrides: Partial<BrowserSession> = {}): BrowserSession {
  return {
    id: "session-1",
    workspaceId: "workspace-1",
    sessionName: "alpha",
    status: "live",
    frameBase64: null,
    lastError: null,
    streamState: "live",
    frameMetadata: null,
    currentUrl: null,
    isPageLoading: false,
    pendingUrl: null,
    streamErrorMessage: null,
    ...overrides,
  };
}

function createPageTab(overrides: Partial<BrowserPageTab> = {}): BrowserPageTab {
  return {
    tabId: "t1",
    label: null,
    title: "First tab",
    url: "https://first.example.com/",
    active: true,
    type: "page",
    ...overrides,
  };
}

function createDiscoveredSession(
  overrides: Partial<BrowserDiscoveredSession> = {}
): BrowserDiscoveredSession {
  return {
    sessionName: "alpha",
    status: "attachable",
    ...overrides,
  };
}

describe("BrowserTab", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    globalThis.window = new GlobalWindow({ url: "http://localhost" }) as unknown as Window &
      typeof globalThis;
    globalThis.document = globalThis.window.document;

    listSessionsMock.mockReset();
    listSessionsMock.mockResolvedValue({ sessions: [], otherSessions: [] });
    listTabsMock.mockReset();
    listTabsMock.mockResolvedValue({ tabs: [], error: undefined });
    selectTabMock.mockReset();
    selectTabMock.mockResolvedValue({ success: true, error: undefined });
    connectMock.mockReset();
    disconnectMock.mockReset();
    setPendingUrlMock.mockReset();
    sendInputMock.mockReset();
    mockSession = null;
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("connects to missing_stream sessions while showing the activating state", async () => {
    listSessionsMock.mockResolvedValue({
      sessions: [createDiscoveredSession({ status: "missing_stream" })],
      otherSessions: [],
    });

    const view = renderWithApi(<BrowserTab workspaceId="workspace-1" projectPath="/project" />);

    await waitFor(() => {
      expect(connectMock).toHaveBeenCalledWith("alpha");
    });

    expect(view.getByText("Activating")).toBeTruthy();
    expect(view.getByText("Starting live preview…")).toBeTruthy();
    expect(view.getByText('Enabling streaming for session "alpha"…')).toBeTruthy();
    expect(view.queryByText(/AGENT_BROWSER_STREAM_PORT/)).toBeNull();
  });

  test("shows other running sessions in the session picker without auto-attaching", async () => {
    listSessionsMock.mockResolvedValue({
      sessions: [],
      otherSessions: [
        {
          sessionName: "other-alpha",
          status: "attachable",
          cwd: "/tmp/other-project",
        },
      ],
    });

    const view = renderWithApi(<BrowserTab workspaceId="workspace-1" projectPath="/project" />);

    await waitFor(() => {
      expect(view.getByText("Select session")).toBeTruthy();
    });
    expect(view.getByText("Choose a browser session")).toBeTruthy();
    expect(view.getByText("Select another session from the picker to connect.")).toBeTruthy();

    fireEvent.click(view.getByText("Select session"));

    expect(view.getByText("Other sessions")).toBeTruthy();
    expect(view.getByText("other-alpha")).toBeTruthy();
    expect(view.getByText("/tmp/other-project")).toBeTruthy();
    expect(connectMock).not.toHaveBeenCalled();
  });

  test("auto-selects current sessions while still listing other sessions in the picker", async () => {
    listSessionsMock.mockResolvedValue({
      sessions: [createDiscoveredSession({ sessionName: "current-alpha" })],
      otherSessions: [
        {
          sessionName: "other-alpha",
          status: "attachable",
          cwd: "/tmp/other-project",
        },
      ],
    });

    const view = renderWithApi(<BrowserTab workspaceId="workspace-1" projectPath="/project" />);

    await waitFor(() => {
      expect(connectMock).toHaveBeenCalledWith("current-alpha");
    });

    fireEvent.click(view.getByText("current-alpha"));

    expect(view.getByTestId("browser-session-current-alpha")).toBeTruthy();
    expect(view.getByTestId("browser-other-session-other-alpha")).toBeTruthy();
  });

  test("lists page tabs for the selected session and switches tabs from the tab strip", async () => {
    listSessionsMock.mockResolvedValue({
      sessions: [createDiscoveredSession()],
      otherSessions: [],
    });
    let tabs = [
      createPageTab(),
      createPageTab({
        tabId: "t2",
        title: "Second tab",
        url: "https://second.example.com/",
        active: false,
      }),
    ];
    listTabsMock.mockImplementation(() => Promise.resolve({ tabs, error: undefined }));
    selectTabMock.mockImplementation(() => {
      tabs = tabs.map((tab) => ({ ...tab, active: tab.tabId === "t2" }));
      return Promise.resolve({ success: true, error: undefined });
    });

    const view = renderWithApi(<BrowserTab workspaceId="workspace-1" projectPath="/project" />);

    await waitFor(() => {
      expect(view.getByRole("tablist", { name: "Browser tabs" })).toBeTruthy();
    });
    expect(view.getByRole("tabpanel", { name: "Browser viewport" }).id).toBe(
      "browser-preview-viewport"
    );
    expect(listTabsMock).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sessionName: "alpha",
    });
    expect(view.getByTestId("browser-page-tab-t1").getAttribute("aria-selected")).toBe("true");

    fireEvent.click(view.getByTestId("browser-page-tab-t2"));

    await waitFor(() => {
      expect(selectTabMock).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        sessionName: "alpha",
        tabRef: "t2",
      });
    });
    await waitFor(() => {
      expect(view.getByTestId("browser-page-tab-t2").getAttribute("aria-selected")).toBe("true");
    });
    expect(view.getByTestId("browser-page-tab-t1").getAttribute("aria-selected")).toBe("false");
  });

  test("supports keyboard navigation in the browser page tab strip", async () => {
    listSessionsMock.mockResolvedValue({
      sessions: [createDiscoveredSession()],
      otherSessions: [],
    });
    listTabsMock.mockResolvedValue({
      tabs: [
        createPageTab(),
        createPageTab({
          tabId: "t2",
          title: "Second tab",
          url: "https://second.example.com/",
          active: false,
        }),
        createPageTab({
          tabId: "t3",
          title: "Third tab",
          url: "https://third.example.com/",
          active: false,
        }),
      ],
      error: undefined,
    });

    const view = renderWithApi(<BrowserTab workspaceId="workspace-1" projectPath="/project" />);

    await view.findByRole("tablist", { name: "Browser tabs" });
    fireEvent.focus(view.getByTestId("browser-page-tab-t1"));
    fireEvent.keyDown(view.getByTestId("browser-page-tab-t1"), { key: "ArrowRight" });

    expect(globalThis.document.activeElement).toBe(view.getByTestId("browser-page-tab-t2"));
    expect(view.getByTestId("browser-page-tab-t1").getAttribute("tabindex")).toBe("-1");
    expect(view.getByTestId("browser-page-tab-t2").getAttribute("tabindex")).toBe("0");

    fireEvent.keyDown(view.getByTestId("browser-page-tab-t2"), { key: "ArrowLeft" });
    expect(globalThis.document.activeElement).toBe(view.getByTestId("browser-page-tab-t1"));

    fireEvent.keyDown(view.getByTestId("browser-page-tab-t1"), { key: "ArrowLeft" });
    expect(globalThis.document.activeElement).toBe(view.getByTestId("browser-page-tab-t3"));

    fireEvent.keyDown(view.getByTestId("browser-page-tab-t3"), { key: "ArrowRight" });
    expect(globalThis.document.activeElement).toBe(view.getByTestId("browser-page-tab-t1"));

    fireEvent.keyDown(view.getByTestId("browser-page-tab-t1"), { key: "End" });
    expect(globalThis.document.activeElement).toBe(view.getByTestId("browser-page-tab-t3"));

    fireEvent.keyDown(view.getByTestId("browser-page-tab-t3"), { key: "Home" });
    expect(globalThis.document.activeElement).toBe(view.getByTestId("browser-page-tab-t1"));
  });

  test("marks the target page tab as busy while switching", async () => {
    listSessionsMock.mockResolvedValue({
      sessions: [createDiscoveredSession()],
      otherSessions: [],
    });
    listTabsMock.mockResolvedValue({
      tabs: [
        createPageTab(),
        createPageTab({
          tabId: "t2",
          title: "Second tab",
          url: "https://second.example.com/",
          active: false,
        }),
      ],
      error: undefined,
    });
    let resolveSelectTab = (): void => {
      throw new Error("selectTab was not called");
    };
    selectTabMock.mockImplementation(
      () =>
        new Promise<{ success: boolean; error: string | undefined }>((resolve) => {
          resolveSelectTab = () => resolve({ success: true, error: undefined });
        })
    );

    const view = renderWithApi(<BrowserTab workspaceId="workspace-1" projectPath="/project" />);

    await view.findByRole("tablist", { name: "Browser tabs" });
    fireEvent.click(view.getByTestId("browser-page-tab-t2"));

    await waitFor(() => {
      expect(view.getByTestId("browser-page-tab-t2").getAttribute("aria-busy")).toBe("true");
    });
    expect(view.getByTestId("browser-page-tab-t1").getAttribute("aria-disabled")).toBe("true");

    resolveSelectTab();
    await waitFor(() => {
      expect(view.getByTestId("browser-page-tab-t2").getAttribute("aria-busy")).toBeNull();
    });
  });

  test("lists and switches page tabs for selected other sessions", async () => {
    listSessionsMock.mockResolvedValue({
      sessions: [],
      otherSessions: [
        {
          sessionName: "other-alpha",
          status: "attachable",
          cwd: "/tmp/other-project",
        },
      ],
    });
    let tabs = [
      createPageTab(),
      createPageTab({
        tabId: "t2",
        title: "Second tab",
        url: "https://second.example.com/",
        active: false,
      }),
    ];
    listTabsMock.mockImplementation(() => Promise.resolve({ tabs, error: undefined }));
    selectTabMock.mockImplementation(() => {
      tabs = tabs.map((tab) => ({ ...tab, active: tab.tabId === "t2" }));
      return Promise.resolve({ success: true, error: undefined });
    });

    const view = renderWithApi(<BrowserTab workspaceId="workspace-1" projectPath="/project" />);

    await waitFor(() => {
      expect(view.getByText("Select session")).toBeTruthy();
    });
    fireEvent.click(view.getByText("Select session"));
    fireEvent.click(view.getByTestId("browser-other-session-other-alpha"));

    await waitFor(() => {
      expect(listTabsMock).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        sessionName: "other-alpha",
        allowOtherWorkspaceSession: true,
      });
    });
    fireEvent.click(view.getByTestId("browser-page-tab-t2"));

    await waitFor(() => {
      expect(selectTabMock).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        sessionName: "other-alpha",
        tabRef: "t2",
        allowOtherWorkspaceSession: true,
      });
    });
  });

  test("hides the page tab strip for a single page tab", async () => {
    listSessionsMock.mockResolvedValue({
      sessions: [createDiscoveredSession()],
      otherSessions: [],
    });
    listTabsMock.mockResolvedValue({ tabs: [createPageTab()], error: undefined });

    const view = renderWithApi(<BrowserTab workspaceId="workspace-1" projectPath="/project" />);

    await waitFor(() => {
      expect(listTabsMock).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        sessionName: "alpha",
      });
    });
    expect(view.queryByRole("tablist", { name: "Browser tabs" })).toBeNull();
    expect(view.queryByRole("tabpanel")).toBeNull();
  });

  test("shows tab listing errors", async () => {
    listSessionsMock.mockResolvedValue({
      sessions: [createDiscoveredSession()],
      otherSessions: [],
    });
    listTabsMock.mockResolvedValue({ tabs: [], error: "tab list failed" });

    const view = renderWithApi(<BrowserTab workspaceId="workspace-1" projectPath="/project" />);

    await waitFor(() => {
      expect(view.getByRole("alert").textContent).toContain("tab list failed");
    });
  });

  test("shows tab switching errors", async () => {
    listSessionsMock.mockResolvedValue({
      sessions: [createDiscoveredSession()],
      otherSessions: [],
    });
    listTabsMock.mockResolvedValue({
      tabs: [
        createPageTab(),
        createPageTab({
          tabId: "t2",
          title: "Second tab",
          url: "https://second.example.com/",
          active: false,
        }),
      ],
      error: undefined,
    });
    selectTabMock.mockResolvedValueOnce({ success: false, error: "tab switch failed" });

    const view = renderWithApi(<BrowserTab workspaceId="workspace-1" projectPath="/project" />);

    await view.findByTestId("browser-page-tab-t2");
    fireEvent.click(view.getByTestId("browser-page-tab-t2"));

    await waitFor(() => {
      expect(view.getByRole("alert").textContent).toContain("tab switch failed");
    });
    expect(view.getByTestId("browser-page-tab-t1").getAttribute("aria-selected")).toBe("true");
    expect(view.getByTestId("browser-page-tab-t2").getAttribute("aria-selected")).toBe("false");
    expect(view.getByTestId("browser-page-tab-t2").getAttribute("aria-busy")).toBeNull();
  });

  test("formats tab labels from labels and URLs", async () => {
    listSessionsMock.mockResolvedValue({
      sessions: [createDiscoveredSession()],
      otherSessions: [],
    });
    listTabsMock.mockResolvedValue({
      tabs: [
        createPageTab({
          title: "https://first.example.com/path",
          url: "https://first.example.com/path",
        }),
        createPageTab({
          tabId: "t2",
          label: "docs",
          title: "",
          url: "data:text/html,<title>Docs</title>",
          active: false,
        }),
        createPageTab({
          tabId: "t3",
          title: "Plain title",
          url: "https://plain.example.com/",
          active: false,
        }),
      ],
      error: undefined,
    });

    const view = renderWithApi(<BrowserTab workspaceId="workspace-1" projectPath="/project" />);

    await view.findByRole("tablist", { name: "Browser tabs" });
    expect(view.getByTestId("browser-page-tab-t1").getAttribute("aria-label")).toBe(
      "Browser tab: first.example.com"
    );
    expect(view.getByTestId("browser-page-tab-t1").textContent).toContain("t1");
    expect(view.getByTestId("browser-page-tab-t2").getAttribute("aria-label")).toBe(
      "Browser tab: docs"
    );
    expect(view.getByTestId("browser-page-tab-t2").textContent).toContain("t2");
    expect(view.getByTestId("browser-page-tab-t3").getAttribute("aria-label")).toBe(
      "Browser tab: Plain title"
    );
  });

  test("can switch from an explicitly selected other session back to a current session", async () => {
    listSessionsMock.mockResolvedValue({
      sessions: [createDiscoveredSession({ sessionName: "current-alpha" })],
      otherSessions: [
        {
          sessionName: "other-alpha",
          status: "attachable",
          cwd: "/tmp/other-project",
        },
      ],
    });

    const view = renderWithApi(<BrowserTab workspaceId="workspace-1" projectPath="/project" />);

    await waitFor(() => {
      expect(connectMock).toHaveBeenCalledWith("current-alpha");
    });

    fireEvent.click(view.getByText("current-alpha"));
    fireEvent.click(view.getByTestId("browser-other-session-other-alpha"));

    await waitFor(() => {
      expect(connectMock).toHaveBeenCalledWith("other-alpha", {
        allowOtherWorkspaceSession: true,
      });
    });

    fireEvent.click(view.getByText("other-alpha"));
    fireEvent.click(view.getByTestId("browser-session-current-alpha"));

    await waitFor(() => {
      expect(connectMock).toHaveBeenLastCalledWith("current-alpha");
    });
  });

  test("attaches to an other running session only after selecting it from the picker", async () => {
    listSessionsMock.mockResolvedValue({
      sessions: [],
      otherSessions: [
        {
          sessionName: "other-alpha",
          status: "attachable",
          cwd: "/tmp/other-project",
        },
      ],
    });

    const view = renderWithApi(<BrowserTab workspaceId="workspace-1" projectPath="/project" />);

    await waitFor(() => {
      expect(view.getByText("Select session")).toBeTruthy();
    });

    fireEvent.click(view.getByText("Select session"));
    fireEvent.click(view.getByTestId("browser-other-session-other-alpha"));

    await waitFor(() => {
      expect(view.getByText("Waiting for browser frames")).toBeTruthy();
    });

    await waitFor(() => {
      expect(connectMock).toHaveBeenCalledWith("other-alpha", {
        allowOtherWorkspaceSession: true,
      });
    });
  });

  test("renders the navigation toolbar with the active session URL", async () => {
    listSessionsMock.mockResolvedValue({
      sessions: [createDiscoveredSession()],
      otherSessions: [],
    });
    mockSession = createSession({
      currentUrl: "https://current.example.com",
      pendingUrl: "https://pending.example.com",
      isPageLoading: true,
    });

    const view = renderWithApi(<BrowserTab workspaceId="workspace-1" projectPath="/project" />);

    await waitFor(() => {
      expect((view.getByLabelText("Browser URL") as HTMLInputElement).value).toBe(
        "https://pending.example.com"
      );
    });

    expect(view.queryByRole("tabpanel")).toBeNull();
    expect((view.getByLabelText("Back") as HTMLButtonElement).disabled).toBe(false);
    expect((view.getByLabelText("Forward") as HTMLButtonElement).disabled).toBe(false);
    expect((view.getByLabelText("Reload") as HTMLButtonElement).disabled).toBe(false);
    expect(view.getByTestId("browser-toolbar-loading-icon")).toBeTruthy();
  });
});

describe("chooseExplicitOtherSession", () => {
  test("preserves an explicitly selected other session while it is still discovered", () => {
    expect(
      chooseExplicitOtherSession("other-alpha", [
        { sessionName: "other-alpha", status: "attachable", cwd: "/tmp/other-project" },
      ])
    ).toBe("other-alpha");
  });

  test("clears an explicitly selected other session when only a different other session exists", () => {
    expect(
      chooseExplicitOtherSession("other-alpha", [
        { sessionName: "other-beta", status: "attachable", cwd: "/tmp/other-project" },
      ])
    ).toBeNull();
  });

  test("clears an explicitly selected other session after discovery loses it", () => {
    expect(chooseExplicitOtherSession("other-alpha", [])).toBeNull();
  });
});

describe("shouldBackOffBrowserReconnect", () => {
  test("backs off retryable reconnects for the same session inside the retry window", () => {
    expect(
      shouldBackOffBrowserReconnect({
        selectedSessionName: "alpha",
        session: createSession({
          sessionName: "alpha",
          status: "error",
          streamState: "error",
          lastError: "disconnected",
        }),
        visibleError: "disconnected",
        lastConnectAttempt: {
          sessionName: "alpha",
          attemptedAtMs: 10_000,
        },
        nowMs: 10_000 + BROWSER_PREVIEW_RETRY_INTERVAL_MS - 1,
      })
    ).toBe(true);
  });

  test("stops backing off once the retry window elapses", () => {
    expect(
      shouldBackOffBrowserReconnect({
        selectedSessionName: "alpha",
        session: createSession({
          sessionName: "alpha",
          status: "error",
          streamState: "error",
          lastError: "disconnected",
        }),
        visibleError: "disconnected",
        lastConnectAttempt: {
          sessionName: "alpha",
          attemptedAtMs: 10_000,
        },
        nowMs: 10_000 + BROWSER_PREVIEW_RETRY_INTERVAL_MS,
      })
    ).toBe(false);
  });

  test('treats "is unavailable" bootstrap races as retryable', () => {
    expect(
      shouldBackOffBrowserReconnect({
        selectedSessionName: "alpha",
        session: createSession({
          sessionName: "alpha",
          status: "error",
          streamState: "error",
          lastError: "Browser session alpha is unavailable.",
        }),
        visibleError: "Browser session alpha is unavailable.",
        lastConnectAttempt: {
          sessionName: "alpha",
          attemptedAtMs: 10_000,
        },
        nowMs: 10_000 + BROWSER_PREVIEW_RETRY_INTERVAL_MS - 1,
      })
    ).toBe(true);
  });

  test("treats failed streaming enablement as retryable", () => {
    expect(
      shouldBackOffBrowserReconnect({
        selectedSessionName: "alpha",
        session: createSession({
          sessionName: "alpha",
          status: "error",
          streamState: "error",
          lastError: 'Failed to enable streaming for session "test"',
        }),
        visibleError: 'Failed to enable streaming for session "test"',
        lastConnectAttempt: {
          sessionName: "alpha",
          attemptedAtMs: 10_000,
        },
        nowMs: 10_000 + BROWSER_PREVIEW_RETRY_INTERVAL_MS - 1,
      })
    ).toBe(true);
  });

  test("treats failed streaming verification as retryable", () => {
    expect(
      shouldBackOffBrowserReconnect({
        selectedSessionName: "alpha",
        session: createSession({
          sessionName: "alpha",
          status: "error",
          streamState: "error",
          lastError:
            'Failed to verify streaming for session "test" after enabling (requested port 12345)',
        }),
        visibleError:
          'Failed to verify streaming for session "test" after enabling (requested port 12345)',
        lastConnectAttempt: {
          sessionName: "alpha",
          attemptedAtMs: 10_000,
        },
        nowMs: 10_000 + BROWSER_PREVIEW_RETRY_INTERVAL_MS - 1,
      })
    ).toBe(true);
  });

  test("does not treat missing sessions as retryable", () => {
    expect(
      shouldBackOffBrowserReconnect({
        selectedSessionName: "alpha",
        session: createSession({
          sessionName: "alpha",
          status: "error",
          streamState: "error",
          lastError: 'Session "test" not found for workspace "ws"',
        }),
        visibleError: 'Session "test" not found for workspace "ws"',
        lastConnectAttempt: {
          sessionName: "alpha",
          attemptedAtMs: 10_000,
        },
        nowMs: 10_000 + BROWSER_PREVIEW_RETRY_INTERVAL_MS - 1,
      })
    ).toBe(false);
  });

  test("does not back off different sessions or non-retryable failures", () => {
    expect(
      shouldBackOffBrowserReconnect({
        selectedSessionName: "beta",
        session: createSession({
          sessionName: "alpha",
          status: "error",
          streamState: "error",
          lastError: "fatal bootstrap failure",
        }),
        visibleError: "fatal bootstrap failure",
        lastConnectAttempt: {
          sessionName: "alpha",
          attemptedAtMs: 10_000,
        },
        nowMs: 10_000 + 1,
      })
    ).toBe(false);
  });
});
