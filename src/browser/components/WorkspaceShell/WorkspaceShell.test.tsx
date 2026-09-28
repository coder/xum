import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render } from "@testing-library/react";
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
  ChatPane: (props: { workspaceId: string }) => (
    <div data-testid="chat-pane">Chat pane for {props.workspaceId}</div>
  ),
}));

void mock.module("@/browser/features/RightSidebar/RightSidebar", () => ({
  RightSidebar: () => <div data-testid="right-sidebar" />,
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

  it("renders loading animation during non-hydrating workspace loading", () => {
    workspaceState = {
      loading: true,
      isHydratingTranscript: false,
    };

    const view = render(<WorkspaceShell {...defaultProps} />);

    expect(view.getByText("Loading workspace...")).toBeTruthy();
    expect(view.getByTestId("lottie-animation")).toBeTruthy();
  });
});
