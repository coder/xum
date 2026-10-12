import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getReviewImmersiveKey, RIGHT_SIDEBAR_COLLAPSED_KEY } from "@/common/constants/storage";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { useEffect, type MutableRefObject } from "react";
import { installDom } from "../../../../tests/ui/dom";
import type * as WorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import * as RealLottieModule from "lottie-react";
import * as RealWorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import * as RealChatPaneModule from "@/browser/components/ChatPane/ChatPane";
import * as RealRightSidebarModule from "@/browser/features/RightSidebar/RightSidebar";
import * as RealThemeContextModule from "@/browser/contexts/ThemeContext";
import * as RealBackgroundBashContextModule from "@/browser/contexts/BackgroundBashContext";
import * as RealOpenTerminalModule from "@/browser/hooks/useOpenTerminal";
import * as RealReviewsModule from "@/browser/hooks/useReviews";
import * as RealConnectionStatusToastModule from "@/browser/components/ConnectionStatusToast/ConnectionStatusToast";
import { restoreModulesAfterSuite } from "../../../../tests/ui/moduleMocks";

interface MockWorkspaceState {
  loading?: boolean;
  isHydratingTranscript?: boolean;
  isStreamStarting?: boolean;
  messages?: Array<{ id: string }>;
  queuedMessage?: { id: string } | null;
}

let cleanupDom: (() => void) | null = null;
let workspaceState: MockWorkspaceState | undefined;
let originalWindowApi: WindowApi | undefined;

const openTerminalMock = mock(() => Promise.resolve());
const addReviewMock = mock(() => undefined);
const addTerminalMock = mock(() => undefined);
// Inline display of the stub right sidebar: "none" stands in for the narrow-layout CSS hide.
let rightSidebarDisplay = "flex";
// While set and pending, the stub suspends: it stands in for the sidebar's chunk still loading.
let sidebarGate: { promise: Promise<void>; state: "pending" | "loaded" | "failed" } | null = null;
function gateSidebar() {
  let settle!: (state: "loaded" | "failed") => void;
  const gate = {
    promise: new Promise<void>((resolve) => (settle = resolve as never)),
    state: "pending",
  };
  sidebarGate = gate as NonNullable<typeof sidebarGate>;
  const finish = (state: "loaded" | "failed") =>
    act(async () => {
      gate.state = state;
      settle(state);
      await gate.promise;
    });
  return { load: () => finish("loaded"), fail: () => finish("failed") };
}
// What the stub sidebar's own window listeners received, in order.
const sidebarInput: string[] = [];
const SIDEBAR_EVENT_TYPES = [
  CUSTOM_EVENTS.OPEN_GOAL_TAB,
  CUSTOM_EVENTS.OPEN_ARTIFACT,
  CUSTOM_EVENTS.OPEN_NEW_SIDEBAR_TAB,
  CUSTOM_EVENTS.EXPAND_RIGHT_SIDEBAR,
];

// Restore every module stubbed below (including the per-test WorkspaceStore double) after
// this suite so the stubs cannot leak into later files.
restoreModulesAfterSuite([
  ["lottie-react", { ...RealLottieModule }],
  ["@/browser/stores/WorkspaceStore", { ...RealWorkspaceStoreModule }],
  ["@/browser/components/ChatPane/ChatPane", { ...RealChatPaneModule }],
  ["@/browser/features/RightSidebar/RightSidebar", { ...RealRightSidebarModule }],
  ["@/browser/contexts/ThemeContext", { ...RealThemeContextModule }],
  ["@/browser/contexts/BackgroundBashContext", { ...RealBackgroundBashContextModule }],
  ["@/browser/hooks/useOpenTerminal", { ...RealOpenTerminalModule }],
  ["@/browser/hooks/useReviews", { ...RealReviewsModule }],
  [
    "@/browser/components/ConnectionStatusToast/ConnectionStatusToast",
    { ...RealConnectionStatusToastModule },
  ],
]);
// Mock lottie-react before importing WorkspaceShell.
void mock.module("lottie-react", () => ({
  __esModule: true,
  default: () => <div data-testid="lottie-animation" />,
}));

function installTestDoubles() {
  // Preserve the remaining WorkspaceStore exports because Bun mock.module state is global across test files.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const actualWorkspaceStore =
    require("@/browser/stores/WorkspaceStore?real=1") as typeof WorkspaceStoreModule;
  /* eslint-enable @typescript-eslint/no-require-imports */

  void mock.module("@/browser/stores/WorkspaceStore", () => ({
    ...actualWorkspaceStore,
    useWorkspaceShellStatus: () => ({
      loading: false,
      isHydratingTranscript: false,
      isStreamStarting: false,
      ...workspaceState,
    }),
  }));
}

void mock.module("@/browser/components/ChatPane/ChatPane", () => ({
  ChatPane: (props: {
    workspaceId: string;
    onOpenTerminal: () => void;
    onOpenSidebar?: (returnFocusTo: HTMLElement | null) => void;
  }) => (
    <div data-testid="chat-pane">
      Chat pane for {props.workspaceId}
      <button type="button" onClick={() => props.onOpenTerminal()}>
        New terminal
      </button>
      <button type="button" onClick={(e) => props.onOpenSidebar?.(e.currentTarget)}>
        Sidebar
      </button>
    </div>
  ),
}));

void mock.module("@/browser/features/RightSidebar/RightSidebar", () => ({
  RightSidebar: (props: {
    addTerminalRef: MutableRefObject<(() => void) | null>;
    fullscreen?: boolean;
    onCloseFullscreen?: () => void;
  }) => {
    // The Suspense protocol: a pending lazy chunk throws its promise.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (sidebarGate?.state === "pending") throw sidebarGate.promise;
    if (sidebarGate?.state === "failed")
      throw new Error("Failed to fetch dynamically imported module");
    props.addTerminalRef.current = addTerminalMock;
    // Like RightSidebar, it subscribes to its shortcuts and events in an effect.
    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if (e.ctrlKey || e.shiftKey) sidebarInput.push(`key:${e.ctrlKey ? "ctrl+" : ""}${e.key}`);
      };
      const onEvent = (e: Event) => sidebarInput.push(e.type);
      window.addEventListener("keydown", onKey);
      for (const type of SIDEBAR_EVENT_TYPES) window.addEventListener(type, onEvent);
      return () => {
        window.removeEventListener("keydown", onKey);
        for (const type of SIDEBAR_EVENT_TYPES) window.removeEventListener(type, onEvent);
      };
    }, []);
    return (
      <div
        data-testid="right-sidebar"
        data-fullscreen={String(props.fullscreen === true)}
        className="mobile-hide-right-sidebar"
        style={{ display: rightSidebarDisplay }}
      >
        <button type="button" onClick={props.onCloseFullscreen}>
          Close sidebar
        </button>
      </div>
    );
  },
}));

void mock.module("@/browser/contexts/ThemeContext", () => ({
  useTheme: () => ({ theme: "dark" }),
}));

void mock.module("@/browser/contexts/BackgroundBashContext", () => ({
  useBackgroundBashError: () => ({
    error: null,
    clearError: () => undefined,
    showError: () => undefined,
  }),
}));

void mock.module("@/browser/hooks/useOpenTerminal", () => ({
  useOpenTerminal: () => openTerminalMock,
}));

void mock.module("@/browser/hooks/useReviews", () => ({
  useReviews: () => ({
    addReview: addReviewMock,
  }),
}));

void mock.module("@/browser/components/ConnectionStatusToast/ConnectionStatusToast", () => ({
  ConnectionStatusToast: () => null,
}));

import { WorkspaceShell, estimateWorkspaceShellFallbackWidthPx } from "./WorkspaceShell";

/** Inert itself or under an inert ancestor (makeOthersInert marks the covered siblings). */
function isInert(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node != null; node = node.parentElement) {
    if (node.inert) return true;
  }
  return false;
}

const defaultProps = {
  workspaceId: "workspace-1",
  projectPath: "/projects/demo",
  projectName: "demo",
  workspaceName: "feature-branch",
  namedWorkspacePath: "/projects/demo/workspaces/feature-branch",
  leftSidebarCollapsed: false,
  onToggleLeftSidebarCollapsed: () => undefined,
};

describe("estimateWorkspaceShellFallbackWidthPx", () => {
  it("subtracts the expanded left sidebar width from the viewport fallback", () => {
    expect(
      estimateWorkspaceShellFallbackWidthPx({
        viewportWidthPx: 1440,
        isStacked: false,
        leftSidebarCollapsed: false,
        persistedLeftSidebarWidthPx: 360,
      })
    ).toBe(1080);
  });

  it("uses the collapsed sidebar width when the left sidebar is hidden", () => {
    expect(
      estimateWorkspaceShellFallbackWidthPx({
        viewportWidthPx: 1440,
        isStacked: false,
        leftSidebarCollapsed: true,
        persistedLeftSidebarWidthPx: 360,
      })
    ).toBe(1420);
  });

  it("falls back to the default left sidebar width for malformed persisted values", () => {
    expect(
      estimateWorkspaceShellFallbackWidthPx({
        viewportWidthPx: 1440,
        isStacked: false,
        leftSidebarCollapsed: false,
        persistedLeftSidebarWidthPx: { bad: true },
      })
    ).toBe(1152);
  });

  it("leaves stacked layouts at full viewport width", () => {
    expect(
      estimateWorkspaceShellFallbackWidthPx({
        viewportWidthPx: 700,
        isStacked: true,
        leftSidebarCollapsed: false,
        persistedLeftSidebarWidthPx: 360,
      })
    ).toBe(700);
  });
});

describe("WorkspaceShell loading placeholders", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    installTestDoubles();
    originalWindowApi = window.api;
    delete window.api;
    workspaceState = undefined;
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    // Restore window.api first while window is still installed.
    if (originalWindowApi === undefined) {
      delete window.api;
    } else {
      window.api = originalWindowApi;
    }
    originalWindowApi = undefined;
    // Now tear down the DOM.
    cleanupDom?.();
    cleanupDom = null;
    workspaceState = undefined;
    openTerminalMock.mockClear();
    addReviewMock.mockClear();
    addTerminalMock.mockClear();
    rightSidebarDisplay = "flex";
    sidebarGate = null;
    sidebarInput.length = 0;
  });

  it("keeps the chat pane mounted during hydration in web mode", () => {
    workspaceState = {
      isHydratingTranscript: true,
      loading: false,
    };

    const view = render(<WorkspaceShell {...defaultProps} />);

    expect(view.queryByText("Catching up with the agent...")).toBeNull();
    expect(view.getByTestId("chat-pane")).toBeTruthy();
  });

  it("keeps the chat pane mounted during initial web workspace loading", () => {
    workspaceState = {
      loading: true,
      isHydratingTranscript: true,
      isStreamStarting: false,
    };

    const view = render(<WorkspaceShell {...defaultProps} />);

    expect(view.queryByText("Loading workspace...")).toBeNull();
    expect(view.getByTestId("chat-pane")).toBeTruthy();
  });

  it("keeps the chat pane mounted during initial Electron workspace loading", () => {
    window.api = { platform: "linux", versions: {} };
    workspaceState = {
      loading: true,
      isHydratingTranscript: true,
      isStreamStarting: false,
    };

    const view = render(<WorkspaceShell {...defaultProps} />);

    expect(view.queryByText("Loading workspace...")).toBeNull();
    expect(view.getByTestId("chat-pane")).toBeTruthy();
  });

  it("keeps cached transcript content visible during web hydration", () => {
    workspaceState = {
      isHydratingTranscript: true,
      isStreamStarting: false,
      loading: false,
      messages: [{ id: "message-1" }],
      queuedMessage: null,
    };

    const view = render(<WorkspaceShell {...defaultProps} />);

    expect(view.queryByText("Catching up with the agent...")).toBeNull();
    expect(view.getByTestId("chat-pane")).toBeTruthy();
  });

  it("keeps the same chat pane DOM node across workspace switches", () => {
    workspaceState = {
      isHydratingTranscript: false,
      isStreamStarting: false,
      loading: false,
      messages: [{ id: "message-1" }],
      queuedMessage: null,
    };

    const view = render(<WorkspaceShell {...defaultProps} />);
    const firstChatPane = view.getByTestId("chat-pane");

    view.rerender(
      <WorkspaceShell
        {...defaultProps}
        workspaceId="workspace-2"
        workspaceName="feature-two"
        namedWorkspacePath="/projects/demo/workspaces/feature-two"
      />
    );

    const secondChatPane = view.getByTestId("chat-pane");
    expect(secondChatPane).toBe(firstChatPane);
    expect(secondChatPane.textContent).toContain("workspace-2");
  });

  it("renders loading animation during non-hydrating workspace loading", async () => {
    workspaceState = {
      loading: true,
      isHydratingTranscript: false,
    };

    const view = render(<WorkspaceShell {...defaultProps} />);

    expect(view.getByText("Loading workspace...")).toBeTruthy();
    expect(await view.findByTestId("lottie-animation")).toBeTruthy();
    // Lighthouse landmark-one-main (#5998): the placeholder replaces ChatPane, whose `main` it
    // must take over. The full-App stories cannot reach this state with the real store, because
    // a story's pending onChat keeps the transcript hydrating, which keeps ChatPane mounted.
    const mains = view.getAllByRole("main");
    expect(mains).toHaveLength(1);
    expect(mains[0].textContent).toContain("Loading workspace...");
  });

  // A narrow window with a mouse: the CSS hides the sidebar, but no coarse-pointer query matches.
  it("opens a terminal popout when the narrow layout hides the right sidebar", () => {
    rightSidebarDisplay = "none";

    const view = render(<WorkspaceShell {...defaultProps} />);
    fireEvent.click(view.getByRole("button", { name: "New terminal" }));

    expect(openTerminalMock).toHaveBeenCalledTimes(1);
    expect(addTerminalMock).not.toHaveBeenCalled();
  });

  it("opens a terminal tab in the right sidebar when the sidebar is visible", () => {
    const view = render(<WorkspaceShell {...defaultProps} />);
    fireEvent.click(view.getByRole("button", { name: "New terminal" }));

    expect(addTerminalMock).toHaveBeenCalledTimes(1);
    expect(openTerminalMock).not.toHaveBeenCalled();
  });

  describe("full-screen sidebar (phones)", () => {
    it("shows the sidebar full-screen from the menu's Sidebar row", () => {
      rightSidebarDisplay = "none";
      const view = render(<WorkspaceShell {...defaultProps} />);
      const sidebar = view.getByTestId("right-sidebar");
      expect(sidebar.dataset.fullscreen).toBe("false");

      fireEvent.click(view.getByRole("button", { name: "Sidebar" }));

      expect(sidebar.dataset.fullscreen).toBe("true");

      // The stub keeps its inline display:none; the real CSS shows it full-screen.
      fireEvent.click(view.getByRole("button", { name: "Close sidebar", hidden: true }));

      expect(sidebar.dataset.fullscreen).toBe("false");
    });

    it("closes on Escape and returns focus to the control that opened it", () => {
      rightSidebarDisplay = "none";
      const view = render(<WorkspaceShell {...defaultProps} />);
      const opener = view.getByRole("button", { name: "Sidebar" });
      fireEvent.click(opener);
      expect(view.getByTestId("right-sidebar").dataset.fullscreen).toBe("true");

      fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });

      expect(view.getByTestId("right-sidebar").dataset.fullscreen).toBe("false");
      expect(document.activeElement).toBe(opener);
    });

    it("closes when switching workspaces and stays closed on the way back", () => {
      rightSidebarDisplay = "none";
      const view = render(<WorkspaceShell {...defaultProps} />);
      fireEvent.click(view.getByRole("button", { name: "Sidebar" }));
      expect(view.getByTestId("right-sidebar").dataset.fullscreen).toBe("true");

      view.rerender(<WorkspaceShell {...defaultProps} workspaceId="workspace-2" />);
      expect(view.getByTestId("right-sidebar").dataset.fullscreen).toBe("false");

      view.rerender(<WorkspaceShell {...defaultProps} />);
      expect(view.getByTestId("right-sidebar").dataset.fullscreen).toBe("false");
    });

    it("closes when the Timeline reveals a message in this workspace's transcript", () => {
      rightSidebarDisplay = "none";
      const view = render(<WorkspaceShell {...defaultProps} />);
      fireEvent.click(view.getByRole("button", { name: "Sidebar" }));
      const reveal = (workspaceId: string) =>
        act(() => {
          window.dispatchEvent(
            createCustomEvent(CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR, { workspaceId })
          );
        });

      reveal("workspace-2");
      expect(view.getByTestId("right-sidebar").dataset.fullscreen).toBe("true");
      reveal(defaultProps.workspaceId);
      expect(view.getByTestId("right-sidebar").dataset.fullscreen).toBe("false");
    });

    it("closes when immersive review starts and stays closed after it ends", () => {
      rightSidebarDisplay = "none";
      const view = render(<WorkspaceShell {...defaultProps} />);
      fireEvent.click(view.getByRole("button", { name: "Sidebar" }));
      expect(view.getByTestId("right-sidebar").dataset.fullscreen).toBe("true");

      act(() => {
        updatePersistedState(getReviewImmersiveKey(defaultProps.workspaceId), true);
      });
      expect(view.getByTestId("right-sidebar").dataset.fullscreen).toBe("false");

      act(() => {
        updatePersistedState(getReviewImmersiveKey(defaultProps.workspaceId), false);
      });
      expect(view.getByTestId("right-sidebar").dataset.fullscreen).toBe("false");
    });
  });

  // T3 #5971: RightSidebar is code-split. Until its chunk loads, the shell keeps the sidebar's
  // place, and nothing meant for the sidebar is lost.
  describe("while the sidebar chunk loads", () => {
    it("keeps the sidebar's box, empty when collapsed (the card floats, so it takes no room)", () => {
      gateSidebar();
      updatePersistedState(RIGHT_SIDEBAR_COLLAPSED_KEY, true);
      const view = render(<WorkspaceShell {...defaultProps} />);
      const box = view.container.querySelector<HTMLElement>(".mobile-hide-right-sidebar");
      expect(view.queryByTestId("right-sidebar")).toBeNull();
      expect(box?.style.width).toBe("0px");
      updatePersistedState(RIGHT_SIDEBAR_COLLAPSED_KEY, false);
    });

    it("shows a loading sidebar full-screen on phones, closable with Close and Escape", () => {
      gateSidebar();
      rightSidebarDisplay = "none";
      const view = render(<WorkspaceShell {...defaultProps} />);
      fireEvent.click(view.getByRole("button", { name: "Sidebar" }));
      expect(view.getByRole("status").textContent).toBe("Loading sidebar...");
      // Like the loaded full-screen sidebar: focus moves in, and the covered chat is inert.
      expect(document.activeElement).toBe(view.getByRole("button", { name: "Close" }));
      expect(isInert(view.getByTestId("chat-pane"))).toBe(true);

      fireEvent.click(view.getByRole("button", { name: "Close" }));
      expect(isInert(view.getByTestId("chat-pane"))).toBe(false);
      expect(view.queryByRole("status")).toBeNull();

      fireEvent.click(view.getByRole("button", { name: "Sidebar" }));
      fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
      expect(view.queryByRole("status")).toBeNull();
    });

    it("delivers its shortcuts, events and terminal requests once, after it mounts", async () => {
      const gate = gateSidebar();
      const view = render(<WorkspaceShell {...defaultProps} />);
      const otherListener: string[] = []; // e.g. WorkspaceMenuBar, which also handles OPEN_ARTIFACT
      const onArtifact = () => otherListener.push("artifact");
      window.addEventListener(CUSTOM_EVENTS.OPEN_ARTIFACT, onArtifact);
      const input = document.createElement("input");
      document.body.appendChild(input);

      fireEvent.keyDown(document.body, { key: "2", ctrlKey: true });
      fireEvent.keyDown(document.body, { key: "K", ctrlKey: true, shiftKey: true });
      fireEvent.keyDown(document.body, { key: "I", shiftKey: true });
      const closeTab = fireEvent.keyDown(document.body, { key: "w", ctrlKey: true });
      const newTab = new window.KeyboardEvent("keydown", {
        key: "n",
        code: "KeyN",
        ctrlKey: true,
        altKey: true,
        bubbles: true,
      });
      // happy-dom infers AltGraph from any Ctrl+Alt chord; model physical Ctrl+Alt here.
      Object.defineProperty(newTab, "getModifierState", { value: () => false });
      fireEvent(document.body, newTab);
      const typed = fireEvent.keyDown(input, { key: "I", shiftKey: true });
      // Not held: its sender opens the side chat full-screen when no sidebar claims the event.
      let sideChatSeen = 0;
      const onSideChat = () => sideChatSeen++;
      window.addEventListener(CUSTOM_EVENTS.OPEN_SIDE_CHAT_TAB, onSideChat);
      const sideChatUnclaimed = window.dispatchEvent(
        createCustomEvent(CUSTOM_EVENTS.OPEN_SIDE_CHAT_TAB, {
          workspaceId: defaultProps.workspaceId,
          sideChatWorkspaceId: "side-1",
        } as never)
      );
      expect([closeTab, sideChatUnclaimed, sideChatSeen]).toEqual([false, true, 1]); // Ctrl+W keeps the window open
      window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.OPEN_GOAL_TAB, { workspaceId: "w" }));
      window.dispatchEvent(
        createCustomEvent(CUSTOM_EVENTS.OPEN_ARTIFACT, { workspaceId: "w" } as never)
      );
      window.dispatchEvent(
        createCustomEvent(CUSTOM_EVENTS.OPEN_NEW_SIDEBAR_TAB, { workspaceId: "w" })
      );
      // The header's stand-in for the collapsed overview card.
      window.dispatchEvent(
        createCustomEvent(CUSTOM_EVENTS.EXPAND_RIGHT_SIDEBAR, { workspaceId: "w" })
      );
      fireEvent.click(view.getByRole("button", { name: "New terminal" }));
      expect(typed).toBe(true); // Shift+I in a text field stays a typed letter
      expect([otherListener, addTerminalMock.mock.calls.length]).toEqual([[], 0]);

      await gate.load();

      expect(sidebarInput).toEqual([
        "key:ctrl+2",
        "key:ctrl+K",
        "key:I",
        "key:ctrl+w",
        "key:ctrl+n",
        CUSTOM_EVENTS.OPEN_GOAL_TAB,
        CUSTOM_EVENTS.OPEN_ARTIFACT,
        CUSTOM_EVENTS.OPEN_NEW_SIDEBAR_TAB,
        CUSTOM_EVENTS.EXPAND_RIGHT_SIDEBAR,
      ]);
      expect([otherListener, addTerminalMock.mock.calls.length]).toEqual([["artifact"], 1]);
      expect(sideChatSeen).toBe(1); // and not replayed
      window.removeEventListener(CUSTOM_EVENTS.OPEN_SIDE_CHAT_TAB, onSideChat);
      window.removeEventListener(CUSTOM_EVENTS.OPEN_ARTIFACT, onArtifact);
      input.remove();
    });

    it("drops a held terminal request when the workspace changes before it mounts", async () => {
      const gate = gateSidebar();
      const view = render(<WorkspaceShell {...defaultProps} />);
      fireEvent.click(view.getByRole("button", { name: "New terminal" }));
      view.rerender(<WorkspaceShell {...defaultProps} workspaceId="workspace-2" />);

      await gate.load();

      expect(addTerminalMock.mock.calls.length).toBe(0);
    });

    it("keeps Close in the full-screen sidebar when its chunk fails", async () => {
      const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
      const gate = gateSidebar();
      rightSidebarDisplay = "none";
      const view = render(<WorkspaceShell {...defaultProps} />);
      fireEvent.click(view.getByRole("button", { name: "Sidebar" }));
      await gate.fail();
      expect(view.getByRole("alert").textContent).toContain("Sidebar failed to load.");

      fireEvent.click(view.getByRole("button", { name: "Close" }));
      expect(isInert(view.getByTestId("chat-pane"))).toBe(false);
      consoleError.mockRestore();
    });

    it("shows a failed collapsed sidebar at its expanded width, so Reload is not clipped", async () => {
      const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
      const gate = gateSidebar();
      updatePersistedState(RIGHT_SIDEBAR_COLLAPSED_KEY, true);
      const view = render(<WorkspaceShell {...defaultProps} />);
      const box = () => view.container.querySelector<HTMLElement>(".mobile-hide-right-sidebar");
      expect(box()?.style.width).toBe("0px");
      await gate.fail();
      expect(box()?.contains(view.getByRole("alert"))).toBe(true);
      expect(box()?.style.width).not.toBe("0px");
      // Docked, with no card: globals.css keys on this to stop reserving the card's room.
      expect(box()?.hasAttribute("data-right-sidebar-load-failed")).toBe(true);
      updatePersistedState(RIGHT_SIDEBAR_COLLAPSED_KEY, false);
      consoleError.mockRestore();
    });

    it("offers a reload in the sidebar's place when its chunk fails", async () => {
      const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
      const gate = gateSidebar();
      const view = render(<WorkspaceShell {...defaultProps} />);
      await gate.fail();
      expect(view.getByRole("alert").textContent).toContain("Sidebar failed to load.");
      expect(view.getByTestId("chat-pane")).toBeTruthy();
      // RightSidebar never mounts, so the shell keeps Cmd/Ctrl+W from closing the window.
      expect(fireEvent.keyDown(document.body, { key: "w", ctrlKey: true })).toBe(false);
      consoleError.mockRestore();
    });

    it("closes the phone full-screen fallback when the layout widens before the chunk loads", () => {
      gateSidebar();
      rightSidebarDisplay = "none";
      // Stands in for globals.css: the full-screen view is `position: fixed` only in the narrow
      // layout. Removing this rule is the widen.
      const narrowLayout = document.createElement("style");
      narrowLayout.textContent = ".right-sidebar-fullscreen { position: fixed; }";
      document.head.appendChild(narrowLayout);
      const mediaQuery = new EventTarget();
      spyOn(window, "matchMedia").mockImplementation(
        () => Object.assign(mediaQuery, { matches: true }) as unknown as MediaQueryList
      );
      const view = render(<WorkspaceShell {...defaultProps} />);
      const opener = view.getByRole("button", { name: "Sidebar" });
      fireEvent.click(opener);
      expect(isInert(view.getByTestId("chat-pane"))).toBe(true);

      // A media change that leaves the layout narrow keeps the view.
      act(() => void mediaQuery.dispatchEvent(new Event("change")));
      expect(view.getByRole("status").textContent).toBe("Loading sidebar...");

      narrowLayout.remove();
      act(() => void mediaQuery.dispatchEvent(new Event("change")));
      expect(view.queryByRole("status")).toBeNull();
      expect(isInert(view.getByTestId("chat-pane"))).toBe(false);
      expect(document.activeElement).toBe(opener);
    });

    it("guards every sidebar shortcut after its chunk fails, but not typed Shift+I", async () => {
      const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
      const gate = gateSidebar();
      render(<WorkspaceShell {...defaultProps} />);
      await gate.fail();
      const tabs = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) =>
        fireEvent.keyDown(document.body, { key: String(n), ctrlKey: true })
      );
      const newTab = new window.KeyboardEvent("keydown", {
        key: "n",
        code: "KeyN",
        ctrlKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true,
      });
      // happy-dom infers AltGraph from any Ctrl+Alt chord; model physical Ctrl+Alt here.
      Object.defineProperty(newTab, "getModifierState", { value: () => false });
      expect({
        tabs,
        artifacts: fireEvent.keyDown(document.body, { key: "K", ctrlKey: true, shiftKey: true }),
        closeTab: fireEvent.keyDown(document.body, { key: "w", ctrlKey: true }),
        newTab: fireEvent(document.body, newTab),
        typedShiftI: fireEvent.keyDown(document.body, { key: "I", shiftKey: true }),
      }).toEqual({
        tabs: Array<boolean>(9).fill(false),
        artifacts: false,
        closeTab: false,
        newTab: false,
        typedShiftI: true,
      });
      consoleError.mockRestore();
    });

    it("releases the held events once when its chunk fails, so the menu bar still gets them", async () => {
      const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
      const gate = gateSidebar();
      render(<WorkspaceShell {...defaultProps} />);
      // Stands in for WorkspaceMenuBar's phone listeners, subscribed after the hold (it re-subscribes
      // whenever the full-screen view opens or closes). For an event dispatched on window, Chromium
      // runs window listeners in registration order, so only a later listener is held from.
      const menuBar: string[] = [];
      const onEvent = (e: Event) => menuBar.push(e.type);
      window.addEventListener(CUSTOM_EVENTS.OPEN_ARTIFACT, onEvent);
      window.addEventListener(CUSTOM_EVENTS.OPEN_MCP_APP_VIEW, onEvent);
      window.dispatchEvent(
        createCustomEvent(CUSTOM_EVENTS.OPEN_ARTIFACT, { workspaceId: "w" } as never)
      );
      window.dispatchEvent(
        createCustomEvent(CUSTOM_EVENTS.OPEN_MCP_APP_VIEW, { workspaceId: "w" } as never)
      );
      expect(menuBar).toEqual([]); // held while the chunk loads

      await gate.fail();

      expect(menuBar).toEqual([CUSTOM_EVENTS.OPEN_ARTIFACT, CUSTOM_EVENTS.OPEN_MCP_APP_VIEW]);
      window.removeEventListener(CUSTOM_EVENTS.OPEN_ARTIFACT, onEvent);
      window.removeEventListener(CUSTOM_EVENTS.OPEN_MCP_APP_VIEW, onEvent);
      consoleError.mockRestore();
    });
  });
});
