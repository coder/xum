/**
 * Integration tests for RightSidebar dock-lite behavior.
 *
 * Tests cover:
 * - The New tab launcher a fresh workspace starts with
 * - Tab switching (costs, review, terminal)
 * - Sidebar collapse/expand
 * - Tab persistence across navigation
 *
 * Note: These tests drive the UI from the user's perspective - clicking tabs,
 * not calling backend APIs directly for the actions being tested.
 */

import "../dom";
import { createEvent, fireEvent, waitFor, within } from "@testing-library/react";

import { getApiKey, shouldRunIntegrationTests } from "../../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  getSharedEnv,
  getSharedRepoPath,
} from "../../ipc/sendMessageTestHelpers";
import { setupProviders, type TestEnvironment } from "../../ipc/setup";
import { generateBranchName } from "../../ipc/helpers";
import { detectDefaultTrunkBranch } from "../../../src/node/git";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

import { installDom } from "../dom";
import { renderApp } from "../renderReviewPanel";
import { cleanupView, disableTutorial, openSidebarNewTab, setupWorkspaceView } from "../helpers";
import {
  getRightSidebarCollapsedKey,
  getReviewImmersiveKey,
  RIGHT_SIDEBAR_TAB_KEY,
  RIGHT_SIDEBAR_WIDTH_KEY,
  getPersistedKeyRegistration,
  getRightSidebarLayoutKey,
  getTerminalTitlesKey,
} from "@/common/constants/storage";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
// RightSidebarLayoutState used for initial setup via persisted-state helpers - acceptable for test fixtures
import {
  getDefaultRightSidebarLayoutState,
  type RightSidebarLayoutState,
} from "@/browser/utils/rightSidebarLayout";
import type { TabType } from "@/browser/types/rightSidebar";
import { openRightSidebarTool, splitRightSidebarPane } from "@/browser/utils/rightSidebarTabFocus";
import { BROWSER_VIEWPORT_ATTR, TERMINAL_CONTAINER_ATTR } from "@/browser/utils/ui/keybinds";

const RIGHT_SIDEBAR_SELECTOR = '[role="complementary"][aria-label="Workspace insights"]';

async function findRequiredElement<T extends HTMLElement = HTMLElement>(
  root: ParentNode,
  selector: string,
  errorMessage: string,
  timeout = 5_000
): Promise<T> {
  return waitFor(
    () => {
      const element = root.querySelector<T>(selector);
      if (!element) throw new Error(errorMessage);
      return element;
    },
    { timeout }
  );
}

function getSidebarWidth(sidebar: HTMLElement): number {
  const styleWidth = sidebar.style.width;
  if (styleWidth.endsWith("px")) {
    return parseInt(styleWidth, 10);
  }
  return sidebar.getBoundingClientRect().width;
}

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("RightSidebar (UI)", () => {
  let env: TestEnvironment;
  let workspaceId: string;
  let metadata: FrontendWorkspaceMetadata;

  beforeAll(async () => {
    await createSharedRepo();

    env = getSharedEnv();
    const projectPath = getSharedRepoPath();

    // These UI tests don't stream or send messages, but the app expects at least one configured provider.
    await setupProviders(env, {
      anthropic: { apiKey: getApiKey("ANTHROPIC_API_KEY") },
    });

    const branchName = generateBranchName("test-right-sidebar");
    const trunkBranch = await detectDefaultTrunkBranch(projectPath);

    const result = await env.orpc.workspace.create({
      projectPath,
      branchName,
      trunkBranch,
    });

    if (!result.success) {
      throw new Error(`Failed to create workspace: ${result.error}`);
    }

    metadata = result.metadata;
    workspaceId = metadata.id;
  }, 60_000);

  afterAll(async () => {
    try {
      if (workspaceId) {
        const sessionIds = await env.orpc.terminal.listSessions({ workspaceId }).catch(() => []);
        await Promise.all(
          sessionIds.map(async (sessionId) => {
            try {
              await env.orpc.terminal.close({ sessionId });
            } catch {
              // Best-effort cleanup.
            }
          })
        );

        const removeResult = await env.orpc.workspace.remove({
          workspaceId,
          options: { force: true },
        });
        if (!removeResult.success) {
          console.warn("Failed to remove workspace during test cleanup:", removeResult.error);
        }
      }
    } finally {
      await cleanupSharedRepo();
    }
  }, 60_000);

  beforeEach(async () => {
    // Reset all right-sidebar persisted state so each test starts clean.
    updatePersistedState(RIGHT_SIDEBAR_TAB_KEY, null);
    updatePersistedState(getRightSidebarCollapsedKey(workspaceId), null);
    updatePersistedState(getReviewImmersiveKey(workspaceId), null);
    await env.orpc.experiments.set({ experimentId: EXPERIMENT_IDS.AGENT_BROWSER, enabled: null });
    await env.orpc.experiments.set({
      experimentId: EXPERIMENT_IDS.PORTABLE_DESKTOP,
      enabled: null,
    });
    updatePersistedState(RIGHT_SIDEBAR_WIDTH_KEY, null);
    updatePersistedState(getRightSidebarLayoutKey(workspaceId), null);
    updatePersistedState(getTerminalTitlesKey(workspaceId), null);

    // Ensure backend terminal sessions don't leak between tests when reusing a workspace.
    const sessionIds = await env.orpc.terminal.listSessions({ workspaceId }).catch(() => []);
    await Promise.all(
      sessionIds.map(async (sessionId) => {
        try {
          await env.orpc.terminal.close({ sessionId });
        } catch {
          // Best-effort cleanup.
        }
      })
    );
  }, 20_000);

  async function setupRightSidebarView(beforeRender?: () => void) {
    const cleanupDom = installDom();
    // Tutorial popovers take focus when their targets appear (the launcher's Terminal row, the
    // immersive review button), so they made this file's focus checks flaky. Cleanup puts back the
    // value from before, so later tests keep whatever default the suite set.
    const tutorialsBefore = globalThis.__MUX_ENABLE_TUTORIALS_IN_SANDBOX__;
    const restoreTutorials = () => {
      globalThis.__MUX_ENABLE_TUTORIALS_IN_SANDBOX__ = tutorialsBefore;
    };
    disableTutorial();
    // Most tests exercise open tools; individual tests can clear this to cover the default.
    updatePersistedState(getRightSidebarCollapsedKey(workspaceId), false);
    beforeRender?.();
    const view = renderApp({ apiClient: env.orpc, metadata });

    try {
      await setupWorkspaceView(view, metadata, workspaceId);
      const sidebar = await findRequiredElement(
        view.container,
        RIGHT_SIDEBAR_SELECTOR,
        "RightSidebar not found",
        10_000
      );
      return {
        view,
        sidebar,
        cleanup: async () => {
          await cleanupView(view, cleanupDom);
          restoreTutorials();
        },
      };
    } catch (error) {
      await cleanupView(view, cleanupDom);
      restoreTutorials();
      throw error;
    }
  }

  const findSidebarTab = (sidebar: HTMLElement, tabKey: string, timeout = 5_000) =>
    findRequiredElement(
      sidebar,
      `[role="tab"][aria-controls*="${tabKey}"]`,
      `${tabKey} tab not found`,
      timeout
    );

  const findSidebarPanel = (sidebar: HTMLElement, panelKey: string, timeout = 5_000) =>
    findRequiredElement(
      sidebar,
      `[role="tabpanel"][id*="${panelKey}"]`,
      `${panelKey} panel not found`,
      timeout
    );

  /** Persist a single-pane layout holding exactly these (open) tabs. */
  function seedLayout(tabs: TabType[], activeTab: TabType = tabs[0]) {
    const layout: RightSidebarLayoutState = {
      version: 1,
      openTabsOnly: true,
      nextId: 2,
      focusedTabsetId: "tabset-1",
      root: { type: "tabset", id: "tabset-1", tabs, activeTab },
    };
    updatePersistedState(getRightSidebarLayoutKey(workspaceId), layout);
  }

  const getTabs = (sidebar: HTMLElement) =>
    Array.from(sidebar.querySelectorAll<HTMLElement>('[role="tab"]'));

  /** The strip's "+" button opens the New tab; its launcher lists the tools. */
  async function openLauncher(sidebar: HTMLElement): Promise<HTMLElement> {
    await openSidebarNewTab(sidebar);
    return findSidebarPanel(sidebar, "-panel-new");
  }

  async function createTerminalTab(sidebar: HTMLElement): Promise<HTMLElement> {
    const launcher = await openLauncher(sidebar);
    fireEvent.click(within(launcher).getByRole("button", { name: "Terminal" }));
    return findSidebarTab(sidebar, "terminal:", 10_000);
  }

  test("does not show browser or desktop tabs by default", async () => {
    const { sidebar, cleanup } = await setupRightSidebarView(() => {
      updatePersistedState(RIGHT_SIDEBAR_TAB_KEY, null);
      updatePersistedState(getRightSidebarLayoutKey(workspaceId), null);
    });

    try {
      await waitFor(() => {
        const browserTab = sidebar.querySelector('[role="tab"][aria-controls*="browser"]');
        const desktopTab = sidebar.querySelector('[role="tab"][aria-controls*="desktop"]');
        expect(browserTab).toBeNull();
        expect(desktopTab).toBeNull();
      });
    } finally {
      await cleanup();
    }
  }, 60_000);

  test("a fresh chat starts collapsed and opens tools only on request", async () => {
    const { view, sidebar, cleanup } = await setupRightSidebarView(() => {
      updatePersistedState(getRightSidebarCollapsedKey(workspaceId), null);
    });

    try {
      expect(sidebar.querySelector(".right-sidebar-overview-card")).not.toBeNull();
      expect(sidebar.querySelector('[role="tablist"]')).toBeNull();
      expect(sidebar.querySelector('[role="tabpanel"]')).toBeNull();
      fireEvent.click(within(view.container).getByRole("button", { name: "Expand right sidebar" }));
      const launcher = await findSidebarPanel(sidebar, "-panel-new");
      expect(within(launcher).getByRole("button", { name: "Review" })).toBeTruthy();
    } finally {
      await cleanup();
    }
  }, 60_000);

  test("a fresh workspace shows only the New tab, whose launcher lists the tools", async () => {
    const { sidebar, cleanup } = await setupRightSidebarView(() => {
      updatePersistedState(RIGHT_SIDEBAR_TAB_KEY, null);
      updatePersistedState(getRightSidebarLayoutKey(workspaceId), null);
    });

    try {
      const launcher = await findSidebarPanel(sidebar, "-panel-new");
      const tabs = getTabs(sidebar);
      expect(tabs).toHaveLength(1);
      expect(tabs[0].getAttribute("aria-selected")).toBe("true");
      // Tools are offered in the launcher instead of as idle tabs.
      for (const name of ["Stats", "Review", "Instructions", "Goal", "Terminal"]) {
        expect(within(launcher).getByRole("button", { name })).toBeTruthy();
      }
      // The only tab is already the New tab, so it offers no close button.
      expect(sidebar.querySelector('button[aria-label^="Close"]')).toBeNull();
    } finally {
      await cleanup();
    }
  }, 60_000);

  test("opening a tool from the New tab replaces it with that tool", async () => {
    const { sidebar, cleanup } = await setupRightSidebarView(() =>
      seedLayout(["costs", "new"], "new")
    );

    try {
      const launcher = await findSidebarPanel(sidebar, "-panel-new");
      fireEvent.click(within(launcher).getByRole("button", { name: "Review" }));

      await findSidebarPanel(sidebar, "review");
      await waitFor(() => {
        const tabs = getTabs(sidebar);
        expect(tabs.map((tab) => tab.getAttribute("aria-controls"))).toEqual([
          expect.stringContaining("costs"),
          expect.stringContaining("review"),
        ]);
        expect(tabs[1].getAttribute("aria-selected")).toBe("true");
      });
    } finally {
      await cleanup();
    }
  }, 60_000);

  // Panels other than Costs and Review are lazy-loaded (T3, #5971): a persisted non-Costs active
  // tab must still render its panel once its chunk arrives, without any user action.
  test("a persisted non-Costs active tab renders its panel after load", async () => {
    const { sidebar, cleanup } = await setupRightSidebarView(() =>
      seedLayout(["costs", "instructions"], "instructions")
    );

    try {
      const panel = await findSidebarPanel(sidebar, "instructions");
      await waitFor(
        () =>
          expect(within(panel).getByRole("button", { name: "Refresh instructions" })).toBeTruthy(),
        { timeout: 10_000 }
      );
    } finally {
      await cleanup();
    }
  }, 60_000);

  // Opening a tool from the New tab keeps keyboard users in the replacement tab. The panel is
  // lazy-loaded, so its body arrives after the tab: focus must still land on the tab, not on body.
  test("opening Instructions from the New tab moves keyboard focus to its tab", async () => {
    const { sidebar, cleanup } = await setupRightSidebarView(() =>
      seedLayout(["costs", "new"], "new")
    );

    try {
      const launcher = await findSidebarPanel(sidebar, "-panel-new");
      fireEvent.click(within(launcher).getByRole("button", { name: "Instructions" }));

      const tab = await findSidebarTab(sidebar, "instructions");
      const panel = await findSidebarPanel(sidebar, "instructions");
      await waitFor(
        () => {
          const active = sidebar.ownerDocument.activeElement;
          // Report a label, not the node: printing a DOM-node mismatch fails in this environment.
          expect(active === tab ? "instructions tab" : active?.tagName).toBe("instructions tab");
          expect(within(panel).getByRole("button", { name: "Refresh instructions" })).toBeTruthy();
        },
        { timeout: 10_000 }
      );
    } finally {
      await cleanup();
    }
  }, 60_000);

  test("offers the browser in the New tab when the experiment is enabled, without opening it", async () => {
    await env.orpc.experiments.set({ experimentId: EXPERIMENT_IDS.AGENT_BROWSER, enabled: true });
    const { sidebar, cleanup } = await setupRightSidebarView(() => {
      updatePersistedState(RIGHT_SIDEBAR_TAB_KEY, null);
      updatePersistedState(getRightSidebarLayoutKey(workspaceId), null);
    });

    try {
      const launcher = await findSidebarPanel(sidebar, "-panel-new");
      await waitFor(() => {
        expect(within(launcher).getByRole("button", { name: "Browser" })).toBeTruthy();
      });
      expect(sidebar.querySelector('[role="tab"][aria-controls*="browser"]')).toBeNull();
    } finally {
      await env.orpc.experiments.set({ experimentId: EXPERIMENT_IDS.AGENT_BROWSER, enabled: null });
      await cleanup();
    }
  }, 60_000);

  test("tab switching updates active tab and persists selection", async () => {
    const { sidebar, cleanup } = await setupRightSidebarView(() => seedLayout(["costs", "review"]));

    try {
      const costsTab = await findSidebarTab(sidebar, "costs");

      // Costs is the seeded active tab
      expect(costsTab.getAttribute("aria-selected")).toBe("true");

      // Click Review tab
      const reviewTab = sidebar.querySelector('[role="tab"][aria-controls*="review"]')!;
      expect(reviewTab).toBeTruthy();
      fireEvent.click(reviewTab);

      // Wait for Review tab to become selected (visible UI state)
      await waitFor(() => {
        expect(reviewTab.getAttribute("aria-selected")).toBe("true");
        expect(costsTab.getAttribute("aria-selected")).toBe("false");
      });

      // Verify Review panel is now visible
      await findSidebarPanel(sidebar, "review");

      const terminalTab = await createTerminalTab(sidebar);

      await waitFor(() => {
        expect(terminalTab.getAttribute("aria-selected")).toBe("true");
        expect(reviewTab.getAttribute("aria-selected")).toBe("false");
      });

      // Verify terminal panel is now visible
      await findSidebarPanel(sidebar, "terminal");
    } finally {
      await cleanup();
    }
  }, 60_000);

  test("closing tabs: a static tab closes, and closing the last tab leaves the New tab", async () => {
    const { sidebar, cleanup } = await setupRightSidebarView(() => seedLayout(["costs", "review"]));

    try {
      fireEvent.click(
        await findRequiredElement(
          sidebar,
          'button[aria-label="Close Review"]',
          "Close Review not found"
        )
      );
      await waitFor(() => {
        expect(sidebar.querySelector('[role="tab"][aria-controls*="review"]')).toBeNull();
      });

      fireEvent.click(
        await findRequiredElement(
          sidebar,
          'button[aria-label="Close Stats"]',
          "Close Stats not found"
        )
      );
      await findSidebarPanel(sidebar, "-panel-new");
      await waitFor(() => {
        expect(getTabs(sidebar)).toHaveLength(1);
        expect(sidebar.querySelector('[role="tab"][aria-controls*="costs"]')).toBeNull();
      });
    } finally {
      await cleanup();
    }
  }, 60_000);

  // #6117 covered a close that leaves tabs in the pane. These cover the close of a pane's last
  // tab: the pane empties (or collapses), and focus must still land on a tab, not <body>.
  const closeByKeyboard = (close: HTMLElement) => {
    close.focus();
    // A focused button turns Enter into a click on itself.
    fireEvent.click(close);
  };
  const activeTabDescription = () => {
    const active = document.activeElement;
    return active?.getAttribute("role") === "tab"
      ? `tab ${active.getAttribute("aria-controls") ?? ""}`
      : (active?.tagName ?? "none");
  };

  test("closing the only pane's last tab by keyboard focuses the New tab", async () => {
    const { sidebar, cleanup } = await setupRightSidebarView(() => seedLayout(["costs"]));
    try {
      closeByKeyboard(
        await findRequiredElement(
          sidebar,
          'button[aria-label="Close Stats"]',
          "Close Stats not found"
        )
      );
      await findSidebarPanel(sidebar, "-panel-new");
      await waitFor(() => expect(activeTabDescription()).toMatch(/^tab .*-panel-new$/));
    } finally {
      await cleanup();
    }
  }, 60_000);

  test("closing a split pane's last tab by keyboard focuses the other pane's tab", async () => {
    const { sidebar, cleanup } = await setupRightSidebarView(() => {
      const layout: RightSidebarLayoutState = {
        version: 1,
        openTabsOnly: true,
        nextId: 3,
        focusedTabsetId: "tabset-2",
        root: {
          type: "split",
          id: "split-1",
          direction: "vertical",
          sizes: [50, 50],
          children: [
            { type: "tabset", id: "tabset-1", tabs: ["costs"], activeTab: "costs" },
            { type: "tabset", id: "tabset-2", tabs: ["review"], activeTab: "review" },
          ],
        },
      };
      updatePersistedState(getRightSidebarLayoutKey(workspaceId), layout);
    });
    try {
      closeByKeyboard(
        await findRequiredElement(
          sidebar,
          'button[aria-label="Close Review"]',
          "Close Review not found"
        )
      );
      await waitFor(() => {
        expect(sidebar.querySelector('[role="tab"][aria-controls*="review"]')).toBeNull();
      });
      await waitFor(() => expect(activeTabDescription()).toMatch(/^tab .*-panel-costs$/));
    } finally {
      await cleanup();
    }
  }, 60_000);

  test("Close Tab leaves the tab alone while the interactive browser has focus", async () => {
    const { sidebar, cleanup } = await setupRightSidebarView(() =>
      seedLayout(["costs", "review"], "review")
    );
    // Stands in for the browser tab's viewport: keystrokes inside it belong to the page.
    const viewport = document.createElement("div");
    viewport.setAttribute(BROWSER_VIEWPORT_ATTR, "");
    const viewportButton = document.createElement("button");
    viewport.appendChild(viewportButton);
    document.body.appendChild(viewport);

    try {
      await findSidebarTab(sidebar, "review");
      const closeTab = { key: "w", ctrlKey: true };

      expect(fireEvent.keyDown(viewportButton, closeTab)).toBe(true);
      expect(sidebar.querySelector('[role="tab"][aria-controls*="review"]')).not.toBeNull();

      // Outside the viewport the same chord still closes the active tab.
      fireEvent.keyDown(window, closeTab);
      await waitFor(() => {
        expect(sidebar.querySelector('[role="tab"][aria-controls*="review"]')).toBeNull();
      });
    } finally {
      viewport.remove();
      await cleanup();
    }
  }, 60_000);

  test("sidebar collapse and expand via button", async () => {
    const { view, sidebar, cleanup } = await setupRightSidebarView(() => {
      // Start expanded
      updatePersistedState(getRightSidebarCollapsedKey(workspaceId), false);
    });

    try {
      // Verify tabs are visible (expanded state)
      await waitFor(() => {
        const tablist = sidebar.querySelector('[role="tablist"]');
        if (!tablist) throw new Error("Tablist should be visible when expanded");
      });

      const toggle = within(view.container).getByRole("button", {
        name: "Collapse right sidebar",
      });
      fireEvent.click(toggle);

      // Wait for collapse - tablist should not be rendered
      await waitFor(() => {
        const tablist = sidebar.querySelector('[role="tablist"]');
        if (tablist) throw new Error("Tablist should be hidden when collapsed");
      });

      // The same element expands the sidebar again.
      expect(toggle.getAttribute("aria-label")).toBe("Expand right sidebar");
      fireEvent.click(toggle);

      // Wait for expand - tablist should be visible again
      await waitFor(() => {
        const tablist = sidebar.querySelector('[role="tablist"]');
        if (!tablist) throw new Error("Tablist should be visible after expand");
      });
    } finally {
      await cleanup();
    }
  }, 60_000);

  test("Ctrl+Shift+B collapses and expands the sidebar, but not from a terminal", async () => {
    const { sidebar, cleanup } = await setupRightSidebarView(() => {
      updatePersistedState(getRightSidebarCollapsedKey(workspaceId), false);
    });
    const tablist = () => sidebar.querySelector('[role="tablist"]');

    try {
      await waitFor(() => {
        if (!tablist()) throw new Error("Tablist should be visible when expanded");
      });

      const chord = { key: "B", code: "KeyB", ctrlKey: true, shiftKey: true };
      fireEvent.keyDown(window, chord);
      await waitFor(() => {
        if (tablist()) throw new Error("Ctrl+Shift+B should collapse the sidebar");
      });

      // A focused terminal keeps the key: the sidebar stays collapsed.
      const terminal = document.createElement("div");
      terminal.setAttribute(TERMINAL_CONTAINER_ATTR, "");
      document.body.append(terminal);
      try {
        fireEvent.keyDown(terminal, chord);
      } finally {
        terminal.remove();
      }
      expect(readPersistedState(getRightSidebarCollapsedKey(workspaceId), false)).toBe(true);

      fireEvent.keyDown(window, chord);
      await waitFor(() => {
        if (!tablist()) throw new Error("Ctrl+Shift+B should expand the sidebar again");
      });
    } finally {
      await cleanup();
    }
  }, 60_000);

  test("Ctrl+Shift+B over an overlay is claimed but does not toggle", async () => {
    const { cleanup } = await setupRightSidebarView(() => {
      updatePersistedState(getRightSidebarCollapsedKey(workspaceId), false);
    });
    // Stand-ins for the overlays that block the toggle. The modal's control stops keydown
    // propagation, as ConfirmationModal's controls do.
    const overlays: [string, (root: HTMLElement) => void][] = [
      ["command palette", (root) => root.setAttribute("cmdk-root", "")],
      ["popover", (root) => root.setAttribute("data-radix-popper-content-wrapper", "")],
      [
        "modal that stops propagation",
        (root) => {
          root.setAttribute("role", "dialog");
          root.setAttribute("aria-modal", "true");
        },
      ],
    ];

    try {
      for (const [name, mark] of overlays) {
        const root = document.createElement("div");
        mark(root);
        const control = document.createElement("button");
        control.addEventListener("keydown", (e) => e.stopPropagation());
        root.append(control);
        document.body.append(root);
        try {
          const chord = { key: "B", code: "KeyB", ctrlKey: true, shiftKey: true };
          // fireEvent returns false when a handler called preventDefault: in a browser, the
          // chord must not fall through to Chrome's bookmarks bar.
          expect({ name, notPrevented: fireEvent.keyDown(control, chord) }).toEqual({
            name,
            notPrevented: false,
          });
          expect(readPersistedState(getRightSidebarCollapsedKey(workspaceId), true)).toBe(false);
        } finally {
          root.remove();
        }
      }
    } finally {
      await cleanup();
    }
  }, 60_000);

  // The toggle sits over the top pane's strip but acts on the whole sidebar, so expanding
  // returns to the pane the user was in.
  test("collapsing over the top pane keeps the focused pane for Expand", async () => {
    const splitLayout: RightSidebarLayoutState = {
      version: 1,
      openTabsOnly: true,
      nextId: 10,
      root: {
        type: "split",
        id: "split-1",
        direction: "horizontal",
        sizes: [50, 50],
        children: [
          { type: "tabset", id: "tabset-top", tabs: ["review"], activeTab: "review" },
          { type: "tabset", id: "tabset-bottom", tabs: ["costs"], activeTab: "costs" },
        ],
      },
      focusedTabsetId: "tabset-bottom",
    };
    const { view, sidebar, cleanup } = await setupRightSidebarView(() => {
      updatePersistedState(getRightSidebarCollapsedKey(workspaceId), false);
      updatePersistedState(getRightSidebarLayoutKey(workspaceId), splitLayout);
    });

    try {
      await findSidebarTab(sidebar, "costs");
      const toggle = within(view.container).getByRole("button", {
        name: "Collapse right sidebar",
      });
      // A real click: mousedown, then focus, then click.
      fireEvent.mouseDown(toggle);
      toggle.focus();
      fireEvent.mouseUp(toggle);
      fireEvent.click(toggle);
      await waitFor(() => expect(sidebar.querySelector('[role="tablist"]')).toBeNull());
      fireEvent.click(toggle);

      await findSidebarTab(sidebar, "costs");
      expect(
        readPersistedState<RightSidebarLayoutState | null>(
          getRightSidebarLayoutKey(workspaceId),
          null
        )?.focusedTabsetId
      ).toBe("tabset-bottom");
    } finally {
      await cleanup();
    }
  }, 60_000);

  test("collapsing keeps the panel mounted over the card until the width transition ends", async () => {
    const { view, sidebar, cleanup } = await setupRightSidebarView(() => seedLayout(["costs"]));
    // happy-dom runs no CSS transitions: stand in for the container's width transition.
    class FakeCSSTransition {
      transitionProperty = "width";
      finish!: () => void;
      finished = new Promise<void>((resolve) => {
        this.finish = resolve;
      });
    }
    let running: FakeCSSTransition | null = null;
    const globals = globalThis as { CSSTransition?: unknown };
    const proto = HTMLElement.prototype as { getAnimations?: () => unknown[] };
    globals.CSSTransition = FakeCSSTransition;
    proto.getAnimations = function (this: HTMLElement) {
      return this === sidebar && running != null ? [running] : [];
    };
    const card = () => sidebar.querySelector(".right-sidebar-overview-card");
    const panel = () => sidebar.querySelector('[role="tabpanel"][id*="costs"]');

    try {
      await findSidebarPanel(sidebar, "-panel-costs");
      const toggle = within(view.container).getByRole("button", {
        name: "Collapse right sidebar",
      });

      const closing = new FakeCSSTransition();
      running = closing;
      fireEvent.click(toggle);
      // The card is revealed under the panel as it slides out.
      expect(card()).not.toBeNull();
      expect(panel()).not.toBeNull();
      running = null;
      closing.finish();
      await waitFor(() => expect(panel()).toBeNull());
      expect(card()).not.toBeNull();

      const opening = new FakeCSSTransition();
      running = opening;
      fireEvent.click(toggle);
      // Expanding drops the card at once and slides the panel in.
      expect(card()).toBeNull();
      expect(panel()).not.toBeNull();
      running = null;
      opening.finish();
      await opening.finished;
      expect(panel()).not.toBeNull();
    } finally {
      delete proto.getAnimations;
      delete globals.CSSTransition;
      await cleanup();
    }
  }, 60_000);

  test("tab selection persists across workspace navigation", async () => {
    // Start with Review tab selected
    const initialLayout: RightSidebarLayoutState = {
      version: 1,
      openTabsOnly: true,
      nextId: 2,
      focusedTabsetId: "tabset-1",
      root: {
        type: "tabset",
        id: "tabset-1",
        tabs: ["costs", "review"],
        activeTab: "review",
      },
    };
    const { view, sidebar, cleanup } = await setupRightSidebarView(() => {
      updatePersistedState(getRightSidebarLayoutKey(workspaceId), initialLayout);
    });

    try {
      // Verify Review tab is selected (from persisted state)
      await waitFor(() => {
        const reviewTab = sidebar.querySelector('[role="tab"][aria-controls*="review"]')!;
        if (!reviewTab) throw new Error("Review tab not found");
        if (reviewTab.getAttribute("aria-selected") !== "true") {
          throw new Error("Review tab should be selected from persisted state");
        }
      });

      // Navigate away by clicking project row (goes to home)
      const projectRow = view.container.querySelector(
        `[data-project-path="${metadata.projectPath}"]`
      )!;
      if (projectRow) {
        fireEvent.click(projectRow);
      }

      // Wait a moment for navigation
      await new Promise((r) => setTimeout(r, 200));

      // Navigate back to workspace
      const workspaceElement = await waitFor(
        () => {
          const el = view.container.querySelector(`[data-workspace-id="${workspaceId}"]`);
          if (!el) throw new Error("Workspace not found in sidebar");
          return el as HTMLElement;
        },
        { timeout: 5_000 }
      );
      fireEvent.click(workspaceElement);

      // Verify Review tab is still selected after navigation
      await waitFor(() => {
        const sidebar2 = view.container.querySelector(
          '[role="complementary"][aria-label="Workspace insights"]'
        );
        if (!sidebar2) throw new Error("Sidebar not found after navigation");
        const reviewTab = sidebar2.querySelector('[role="tab"][aria-controls*="review"]')!;
        if (!reviewTab) throw new Error("Review tab not found after navigation");
        if (reviewTab.getAttribute("aria-selected") !== "true") {
          throw new Error("Review tab selection should persist across navigation");
        }
      });
    } finally {
      await cleanup();
    }
  }, 60_000);

  test("correct tab content is displayed for each tab", async () => {
    const { sidebar, cleanup } = await setupRightSidebarView(() => seedLayout(["costs", "review"]));

    try {
      // Switch to Costs tab and verify content
      const costsTab = await findSidebarTab(sidebar, "costs");
      fireEvent.click(costsTab);
      await findSidebarPanel(sidebar, "costs");

      // Switch to Review tab and verify content
      const reviewTab = await findSidebarTab(sidebar, "review");
      fireEvent.click(reviewTab);
      await findSidebarPanel(sidebar, "review");

      // Create a terminal from a New tab's launcher, and verify its content
      const terminalTab = await createTerminalTab(sidebar);

      await waitFor(() => {
        expect(terminalTab.getAttribute("aria-selected")).toBe("true");
      });

      await findSidebarPanel(sidebar, "terminal");
    } finally {
      await cleanup();
    }
  }, 60_000);

  test("sidebar width persists consistently across costs and review tabs", async () => {
    const { sidebar, cleanup } = await setupRightSidebarView(() => {
      // Clear any persisted width state
      updatePersistedState(RIGHT_SIDEBAR_WIDTH_KEY, null);
      seedLayout(["costs", "review"]);
    });

    try {
      // Find the resize handle (left edge of sidebar)
      const resizeHandle = await waitFor(
        () => {
          const handle = sidebar.querySelector('[class*="cursor-col-resize"]')!;
          if (!handle) throw new Error("Resize handle not found");
          return handle;
        },
        { timeout: 5_000 }
      );

      // Simulate drag resize to 500px
      // Start on Costs tab (seeded)
      const costsTab = await waitFor(
        () => {
          const tab = sidebar.querySelector('[role="tab"][aria-controls*="costs"]');
          if (!tab) throw new Error("Costs tab not found");
          return tab;
        },
        { timeout: 5_000 }
      );
      expect(costsTab.getAttribute("aria-selected")).toBe("true");

      const initialWidth = getSidebarWidth(sidebar);

      // Shrink slightly rather than grow so this test remains stable even when the initial
      // sidebar width is already clamped by the available shell width, while still keeping
      // the neighboring tabs visible.
      fireEvent.pointerDown(resizeHandle, { clientX: 800 });
      fireEvent.pointerMove(document, { clientX: 830 });
      fireEvent.pointerUp(document);

      // Wait for width to change (resize should update inline style)
      await waitFor(() => {
        const width = getSidebarWidth(sidebar);
        if (width >= initialWidth) {
          throw new Error(`Expected width < ${initialWidth}, got ${width}`);
        }
      });

      const widthAfterResize = getSidebarWidth(sidebar);

      // Switch to Review tab
      const reviewTab = await waitFor(
        () => {
          const tab = sidebar.querySelector('[role="tab"][aria-controls*="review"]');
          if (!tab) throw new Error("Review tab not found");
          return tab;
        },
        { timeout: 5_000 }
      );
      fireEvent.click(reviewTab);

      await waitFor(() => {
        expect(reviewTab.getAttribute("aria-selected")).toBe("true");
      });

      // Width should still be the same (unified across tabs) - verify via UI
      expect(getSidebarWidth(sidebar)).toBe(widthAfterResize);
    } finally {
      await cleanup();
    }
  }, 60_000);

  test("resizing works the same regardless of which tab is active", async () => {
    const { sidebar, cleanup } = await setupRightSidebarView(() => {
      // Clear any persisted state
      updatePersistedState(RIGHT_SIDEBAR_WIDTH_KEY, null);
      seedLayout(["costs", "review"]);
    });

    try {
      // Switch to Review tab first
      const reviewTab = await waitFor(
        () => {
          const tab = sidebar.querySelector('[role="tab"][aria-controls*="review"]');
          if (!tab) throw new Error("Review tab not found");
          return tab;
        },
        { timeout: 5_000 }
      );
      fireEvent.click(reviewTab);

      await waitFor(() => {
        expect(reviewTab.getAttribute("aria-selected")).toBe("true");
      });

      // Find and use resize handle
      const resizeHandle = await waitFor(
        () => {
          const handle = sidebar.querySelector('[class*="cursor-col-resize"]')!;
          if (!handle) throw new Error("Resize handle not found");
          return handle;
        },
        { timeout: 5_000 }
      );

      const initialWidth = getSidebarWidth(sidebar);

      // Shrink slightly while on Review so the assertion is stable even when the sidebar
      // starts at the maximum width allowed by the current shell measurement, while still
      // leaving enough room for the tab strip itself.
      fireEvent.pointerDown(resizeHandle, { clientX: 800 });
      fireEvent.pointerMove(document, { clientX: 830 });
      fireEvent.pointerUp(document);

      // Wait for width to change in UI
      await waitFor(() => {
        const width = getSidebarWidth(sidebar);
        if (width >= initialWidth) {
          throw new Error(`Expected width < ${initialWidth}, got ${width}`);
        }
      });

      const widthAfterReviewResize = getSidebarWidth(sidebar);

      // Switch to Costs tab
      const costsTab = await waitFor(
        () => {
          const tab = sidebar.querySelector('[role="tab"][aria-controls*="costs"]');
          if (!tab) throw new Error("Costs tab not found");
          return tab;
        },
        { timeout: 5_000 }
      );
      fireEvent.click(costsTab);

      await waitFor(() => {
        expect(costsTab.getAttribute("aria-selected")).toBe("true");
      });

      // Width should persist when switching to Costs (verify via UI)
      expect(getSidebarWidth(sidebar)).toBe(widthAfterReviewResize);

      // Resize again on Costs tab (shrink).
      // The sidebar may already be clamped to its max width depending on the viewport,
      // so shrinking is the most reliable way to ensure a second drag produces a change.
      fireEvent.pointerDown(resizeHandle, { clientX: 800 });
      fireEvent.pointerMove(document, { clientX: 900 });
      fireEvent.pointerUp(document);

      await waitFor(() => {
        const width = getSidebarWidth(sidebar);
        if (width === widthAfterReviewResize) throw new Error("Width should have changed");
      });

      const widthAfterCostsResize = getSidebarWidth(sidebar);

      // Switch back to Review - should have same new width (verify via UI)
      fireEvent.click(reviewTab);
      await waitFor(() => {
        expect(reviewTab.getAttribute("aria-selected")).toBe("true");
      });

      expect(getSidebarWidth(sidebar)).toBe(widthAfterCostsResize);
    } finally {
      await cleanup();
    }
  }, 60_000);

  test("sidebar cannot be resized beyond available width", async () => {
    const { sidebar, cleanup } = await setupRightSidebarView(() => {
      // Force a narrow viewport so the right sidebar max clamp is exercised.
      Object.defineProperty(window, "innerWidth", { value: 900, configurable: true });
      window.dispatchEvent(new Event("resize"));
    });

    try {
      const resizeHandle = await waitFor(
        () => {
          const handle = sidebar.querySelector('[class*="cursor-col-resize"]')!;
          if (!handle) throw new Error("Resize handle not found");
          return handle;
        },
        { timeout: 5_000 }
      );

      const chatMinWidthPx = 384; // ChatPane uses tailwind `min-w-96`
      const expectedMaxWidth = 900 - chatMinWidthPx;

      fireEvent.pointerDown(resizeHandle, { clientX: 1000 });
      // Move far left to try to exceed max width.
      fireEvent.pointerMove(document, { clientX: 0 });
      fireEvent.pointerUp(document);

      await waitFor(() => {
        const styleWidth = sidebar.style.width;
        if (!styleWidth.endsWith("px")) {
          throw new Error("Expected sidebar width to be set inline");
        }

        const width = parseInt(styleWidth, 10);
        if (width > expectedMaxWidth) {
          throw new Error(`Expected width <= ${expectedMaxWidth}, got ${width}`);
        }
      });
    } finally {
      await cleanup();
    }
  }, 60_000);

  test("dragging the handle far right collapses into the overview card, which reopens Review", async () => {
    const { view, sidebar, cleanup } = await setupRightSidebarView(() => {
      updatePersistedState(getRightSidebarCollapsedKey(workspaceId), false);
      seedLayout(["costs"]);
    });

    try {
      const resizeHandle = await findRequiredElement(
        sidebar,
        '[class*="cursor-col-resize"]',
        "Resize handle not found"
      );
      const widthBeforeDrag = getSidebarWidth(sidebar);

      // Moving the handle right by the sidebar's whole width asks for a 0px sidebar, far past
      // the snap point, so the sidebar collapses instead of holding at its minimum width.
      fireEvent.pointerDown(resizeHandle, { clientX: 800 });
      fireEvent.pointerMove(document, { clientX: 800 + widthBeforeDrag });
      fireEvent.pointerUp(document);

      const card = await waitFor(() => {
        const element = view.container.querySelector<HTMLElement>(RIGHT_SIDEBAR_SELECTOR);
        if (!element) throw new Error("Collapsed sidebar not found");
        if (element.querySelector('[role="tablist"]')) {
          throw new Error("Sidebar should collapse when dragged past the snap point");
        }
        return element;
      });

      // The card's Changes row reopens the sidebar on Review, at the width it had before the drag.
      fireEvent.click(within(card).getByRole("button", { name: /Changes/ }));
      const expanded = await findRequiredElement(
        view.container,
        RIGHT_SIDEBAR_SELECTOR,
        "RightSidebar not found after expand"
      );
      await waitFor(() => {
        const reviewTab = expanded.querySelector('[role="tab"][aria-controls*="review"]');
        if (reviewTab?.getAttribute("aria-selected") !== "true") {
          throw new Error("Review tab should be selected after expanding from the card");
        }
      });
      expect(getSidebarWidth(expanded)).toBe(widthBeforeDrag);
    } finally {
      await cleanup();
    }
  }, 60_000);

  test("split layout renders multiple panes with separate tablists", async () => {
    // Set up a split layout with two panes (top: costs, bottom: review)
    const splitLayout: RightSidebarLayoutState = {
      version: 1,
      openTabsOnly: true,
      nextId: 10,
      root: {
        type: "split",
        id: "split-1",
        direction: "horizontal",
        sizes: [50, 50],
        children: [
          { type: "tabset", id: "tabset-top", tabs: ["costs"], activeTab: "costs" },
          { type: "tabset", id: "tabset-bottom", tabs: ["review"], activeTab: "review" },
        ],
      },
      focusedTabsetId: "tabset-top",
    };
    const { sidebar, cleanup } = await setupRightSidebarView(() => {
      updatePersistedState(getRightSidebarLayoutKey(workspaceId), splitLayout);
    });

    try {
      // Wait for both tablists (two panes)
      await waitFor(() => {
        const tablists = sidebar.querySelectorAll('[role="tablist"]');
        if (tablists.length < 2) throw new Error(`Expected 2 tablists, found ${tablists.length}`);
      });

      const tablists = sidebar.querySelectorAll('[role="tablist"]');
      expect(tablists.length).toBe(2);

      // Verify top pane has Costs tab selected
      const topTablist = tablists[0] as HTMLElement;
      const costsTab = topTablist.querySelector('[role="tab"]')!;
      expect(costsTab).toBeTruthy();
      expect(costsTab.getAttribute("aria-selected")).toBe("true");

      // Verify bottom pane has Review tab selected
      const bottomTablist = tablists[1] as HTMLElement;
      const reviewTab = bottomTablist.querySelector('[role="tab"]')!;
      expect(reviewTab).toBeTruthy();
      expect(reviewTab.getAttribute("aria-selected")).toBe("true");

      // Verify both tabpanels are rendered
      const costsPanel = sidebar.querySelector('[role="tabpanel"][id*="costs"]');
      const reviewPanel = sidebar.querySelector('[role="tabpanel"][id*="review"]');
      expect(costsPanel).toBeTruthy();
      expect(reviewPanel).toBeTruthy();

      // Room for the shell's one toggle, in the top pane's strip only.
      const toggleRooms = sidebar.querySelectorAll('button[aria-hidden="true"][tabindex="-1"]');
      expect(toggleRooms.length).toBe(1);
      expect(toggleRooms[0].closest("[data-tabset-id]")?.getAttribute("data-tabset-id")).toBe(
        "tabset-top"
      );
    } finally {
      await cleanup();
    }
  }, 60_000);

  test("Close Tab closes the active tab of the pane holding keyboard focus", async () => {
    // Focus sits in the bottom pane while the layout still names the top one: keyboard focus
    // moves without the mousedown that used to be the only thing updating it.
    const splitLayout: RightSidebarLayoutState = {
      version: 1,
      openTabsOnly: true,
      nextId: 10,
      root: {
        type: "split",
        id: "split-1",
        direction: "horizontal",
        sizes: [50, 50],
        children: [
          { type: "tabset", id: "tabset-top", tabs: ["costs"], activeTab: "costs" },
          { type: "tabset", id: "tabset-bottom", tabs: ["review"], activeTab: "review" },
        ],
      },
      focusedTabsetId: "tabset-top",
    };
    const { sidebar, cleanup } = await setupRightSidebarView(() => {
      updatePersistedState(getRightSidebarLayoutKey(workspaceId), splitLayout);
    });

    try {
      const reviewPanel = await findSidebarPanel(sidebar, "-panel-review");
      fireEvent.keyDown(reviewPanel, { key: "w", ctrlKey: true });

      await waitFor(() => {
        expect(sidebar.querySelector('[role="tab"][aria-controls*="review"]')).toBeNull();
      });
      expect(sidebar.querySelector('[role="tab"][aria-controls*="costs"]')).not.toBeNull();
    } finally {
      await cleanup();
    }
  }, 60_000);

  test.each(["costs", "new"] as const)(
    "Close Tab preserves the hidden sidebar's active %s tab",
    async (tab) => {
      const { sidebar, cleanup } = await setupRightSidebarView(() => seedLayout([tab, "review"]));
      try {
        const activeTab = await findSidebarTab(sidebar, tab);
        const composer = within(document.body).getByRole("textbox", { name: "Message" });
        composer.focus();
        // happy-dom does not apply the responsive stylesheet; reproduce its computed result.
        sidebar.style.display = "none";
        fireEvent.keyDown(composer, { key: "w", ctrlKey: true });
        expect(getTabs(sidebar)).toHaveLength(2);
        expect(activeTab.getAttribute("aria-selected")).toBe("true");

        // The same shortcut still closes the tab once the sidebar is visible again.
        sidebar.style.removeProperty("display");
        fireEvent.keyDown(composer, { key: "w", ctrlKey: true });
        await waitFor(() => expect(getTabs(sidebar)).toHaveLength(1));
        expect(sidebar.contains(activeTab)).toBe(false);
      } finally {
        sidebar.style.removeProperty("display");
        await cleanup();
      }
    },
    60_000
  );

  test("New Tab leaves keystrokes and focus in the controlled browser", async () => {
    const { sidebar, cleanup } = await setupRightSidebarView(() => seedLayout(["costs"]));
    const viewport = document.createElement("div");
    viewport.setAttribute(BROWSER_VIEWPORT_ATTR, "");
    const input = document.createElement("input");
    viewport.appendChild(input);
    document.body.appendChild(viewport);
    try {
      await findSidebarTab(sidebar, "costs");
      input.focus();
      const pressNewTab = (target: HTMLElement | Window) => {
        const event = createEvent.keyDown(target, {
          key: "n",
          code: "KeyN",
          ctrlKey: true,
          altKey: true,
        });
        // happy-dom infers AltGraph from any Ctrl+Alt chord; model physical Ctrl+Alt here.
        Object.defineProperty(event, "getModifierState", { value: () => false });
        return fireEvent(target, event);
      };
      expect(pressNewTab(input)).toBe(true);
      expect(document.activeElement).toBe(input);
      expect(getTabs(sidebar)).toHaveLength(1);
      expect(sidebar.querySelector('[role="tabpanel"][id$="-panel-new"]')).toBeNull();

      // The same chord still opens and focuses the launcher outside a controlled viewport.
      input.blur();
      pressNewTab(window);
      const launcher = await findSidebarPanel(sidebar, "-panel-new");
      await waitFor(() => expect(launcher.contains(document.activeElement)).toBe(true));
    } finally {
      viewport.remove();
      await cleanup();
    }
  }, 60_000);

  test("the palette's New Tab request opens the launcher with focus in it", async () => {
    const { sidebar, cleanup } = await setupRightSidebarView(() => seedLayout(["costs"]));

    try {
      await findSidebarTab(sidebar, "costs");
      window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.OPEN_NEW_SIDEBAR_TAB, { workspaceId }));

      const launcher = await findSidebarPanel(sidebar, "-panel-new");
      await waitFor(() => {
        expect(launcher.contains(document.activeElement)).toBe(true);
      });
    } finally {
      await cleanup();
    }
  }, 60_000);

  test("the palette's splits reveal the sidebar and move focus into the new pane", async () => {
    const { sidebar, cleanup } = await setupRightSidebarView(() => {
      seedLayout(["costs", "goal"]);
      updatePersistedState(getRightSidebarCollapsedKey(workspaceId), true);
    });
    // What the palette's "Right Sidebar: Split Horizontally/Vertically" runs.
    const split = (direction: "horizontal" | "vertical") =>
      splitRightSidebarPane(workspaceId, direction);

    try {
      // From two tabs, the split moves the shown one (Stats) to the new pane: focus follows it.
      split("vertical");
      await waitFor(() => {
        const active = document.activeElement;
        expect(active?.getAttribute("role")).toBe("tab");
        expect(active?.getAttribute("aria-controls")).toContain("-panel-costs");
      });
      expect(readPersistedState(getRightSidebarCollapsedKey(workspaceId), true)).toBe(false);

      // Stats is now alone in the focused pane, so the next split gives the new pane a New tab:
      // focus lands on its launcher's first row.
      split("horizontal");
      const launcher = await findSidebarPanel(sidebar, "-panel-new");
      await waitFor(() => {
        expect(document.activeElement).toBe(launcher.querySelector("button"));
      });
    } finally {
      await cleanup();
    }
  }, 60_000);

  test("the palette's Add Tool reveals the sidebar with focus on the tool's tab", async () => {
    const { sidebar, cleanup } = await setupRightSidebarView(() => {
      updatePersistedState(getRightSidebarCollapsedKey(workspaceId), true);
    });

    try {
      // What the palette's "Right Sidebar: Add Tool…" runs for Stats.
      openRightSidebarTool(workspaceId, "costs");
      const statsTab = await findSidebarTab(sidebar, "costs");
      await waitFor(() => expect(document.activeElement).toBe(statsTab));
      expect(readPersistedState(getRightSidebarCollapsedKey(workspaceId), true)).toBe(false);
    } finally {
      await cleanup();
    }
  }, 60_000);

  // The palette's split and Add Tool must not move focus into a sidebar that cannot be seen. In
  // a real browser focus() on a hidden element does nothing, but happy-dom moves focus anyway,
  // so these fail if the sidebar stops checking (usePaletteTabFocus's isSidebarShown).
  // Boolean checks: a failed toBe() on two DOM elements makes this jest setup fail while it prints
  // them ("Cannot assign to read only property 'versions'"), which hides the real failure.
  const expectPaletteKeepsFocusOutOf = async (sidebar: HTMLElement, outside: HTMLElement) => {
    const container = sidebar.closest<HTMLElement>("[data-right-sidebar-phase]")!;
    outside.focus();
    splitRightSidebarPane(workspaceId, "vertical");
    // The layout still changes: the new pane shows its launcher.
    await waitFor(() => expect(sidebar.querySelectorAll('[id$="-panel-new"]')).toHaveLength(1));
    expect(container.contains(document.activeElement)).toBe(false);

    openRightSidebarTool(workspaceId, "instructions");
    await findSidebarTab(sidebar, "instructions");
    expect(container.contains(document.activeElement)).toBe(false);
  };

  test("the palette keeps focus out of the sidebar while the narrow layout hides it", async () => {
    const { sidebar, cleanup } = await setupRightSidebarView(() => seedLayout(["costs"]));
    const outside = document.body.appendChild(document.createElement("button"));
    try {
      await findSidebarTab(sidebar, "costs");
      // What the narrow layout's CSS does (isRightSidebarResponsivelyHidden reads display).
      const container = sidebar.closest<HTMLElement>("[data-right-sidebar-phase]")!;
      container.style.display = "none";
      await expectPaletteKeepsFocusOutOf(sidebar, outside);
    } finally {
      outside.remove();
      await cleanup();
    }
  }, 60_000);

  test("the palette keeps focus out of the sidebar while immersive review covers it", async () => {
    // Immersive review needs a mounted Review panel. It sits in its own pane, so the split of the
    // focused (Stats) pane does not remount it: a remount focuses the immersive view by design.
    const layout: RightSidebarLayoutState = {
      version: 1,
      openTabsOnly: true,
      nextId: 10,
      root: {
        type: "split",
        id: "split-1",
        direction: "horizontal",
        sizes: [50, 50],
        children: [
          { type: "tabset", id: "tabset-review", tabs: ["review"], activeTab: "review" },
          { type: "tabset", id: "tabset-stats", tabs: ["costs"], activeTab: "costs" },
        ],
      },
      focusedTabsetId: "tabset-stats",
    };
    const { sidebar, cleanup } = await setupRightSidebarView(() => {
      updatePersistedState(getRightSidebarLayoutKey(workspaceId), layout);
      updatePersistedState(getReviewImmersiveKey(workspaceId), true);
    });
    const outside = document.body.appendChild(document.createElement("button"));
    try {
      await findSidebarTab(sidebar, "review");
      await waitFor(() =>
        expect(sidebar.closest("[data-right-sidebar-phase]")?.getAttribute("aria-hidden")).toBe(
          "true"
        )
      );

      await expectPaletteKeepsFocusOutOf(sidebar, outside);
    } finally {
      outside.remove();
      await cleanup();
    }
  }, 60_000);

  test.each([
    ["review", "Review"],
    ["artifacts", "Artifacts"],
  ] as const)(
    "%s takes focus in the pane that opened it, not in another pane that shows it",
    async (tool, name) => {
      // The tool is open in both panes (a drag can do that). Every path that focuses its panel
      // must focus the copy in the pane it targets: here the first pane.
      if (tool === "artifacts") {
        await env.orpc.experiments.set({ experimentId: EXPERIMENT_IDS.ARTIFACTS, enabled: true });
      }
      const layout: RightSidebarLayoutState = {
        version: 1,
        openTabsOnly: true,
        nextId: 10,
        root: {
          type: "split",
          id: "split-1",
          direction: "horizontal",
          sizes: [50, 50],
          children: [
            { type: "tabset", id: "tabset-a", tabs: [tool, "new"], activeTab: tool },
            { type: "tabset", id: "tabset-b", tabs: [tool], activeTab: tool },
          ],
        },
        focusedTabsetId: "tabset-a",
      };
      const { sidebar, cleanup } = await setupRightSidebarView();
      const outside = document.body.appendChild(document.createElement("button"));
      const panelOf = (tabsetId: string) =>
        sidebar.querySelector<HTMLElement>(`[id$="-${tabsetId}-panel-${tool}"]`);
      const expectFocusInFirstPane = () =>
        waitFor(() => {
          const active = document.activeElement;
          expect(active !== outside && panelOf("tabset-a")?.contains(active) === true).toBe(true);
          expect(panelOf("tabset-b")?.contains(active)).toBe(false);
        });

      try {
        // The layout goes in once the fresh workspace's launcher offers the tool: an Artifacts
        // tab stored while its experiment still reads off is pruned (useExperimentGatedTab).
        const launcher0 = await findSidebarPanel(sidebar, "-panel-new");
        await waitFor(
          () =>
            expect(
              within(launcher0).getByRole("button", { name: new RegExp(`^${name}\\b`) })
            ).toBeTruthy(),
          { timeout: 10_000 }
        );
        updatePersistedState(getRightSidebarLayoutKey(workspaceId), layout);
        // Both panels load lazily, and a panel takes focus only once loaded.
        await waitFor(
          () => {
            for (const tabsetId of ["tabset-a", "tabset-b"]) {
              const loaded = panelOf(tabsetId)?.querySelector(`[data-testid="${tool}-panel"]`);
              expect(loaded != null).toBe(true);
            }
          },
          { timeout: 10_000 }
        );

        // The palette's "Add Tool…" (the focused pane already shows the tool).
        outside.focus();
        openRightSidebarTool(workspaceId, tool);
        await expectFocusInFirstPane();

        // Ctrl+1: the first tab of the layout is the first pane's copy.
        outside.focus();
        fireEvent.keyDown(window, { key: "1", ctrlKey: true });
        await expectFocusInFirstPane();

        // The first pane's New tab launcher: picking the tool selects the copy in that pane.
        // Its "+" button: opening the tool from the palette closed that pane's New tab.
        fireEvent.click(within(sidebar).getAllByRole("button", { name: "New tab" })[0]);
        const launcher = await findSidebarPanel(sidebar, "tabset-a-panel-new");
        outside.focus();
        fireEvent.click(within(launcher).getByRole("button", { name: new RegExp(`^${name}\\b`) }));
        await expectFocusInFirstPane();
      } finally {
        outside.remove();
        await cleanup();
        if (tool === "artifacts") {
          await env.orpc.experiments.set({ experimentId: EXPERIMENT_IDS.ARTIFACTS, enabled: null });
        }
      }
    },
    60_000
  );

  test("a new terminal gets its tab even when the layout no longer fits its budget", async () => {
    // Pad the tabset id so the layout sits just under its budget: with a terminal tab (~45 chars)
    // it no longer fits. That layout write used to be refused, so the terminal never got a tab.
    const layoutKey = getRightSidebarLayoutKey(workspaceId);
    const layoutBudget = getPersistedKeyRegistration(layoutKey)!.maxValueChars;
    const base = getDefaultRightSidebarLayoutState("costs");
    const padding = "p".repeat(Math.floor((layoutBudget - 20 - JSON.stringify(base).length) / 2));
    const tabsetId = `${base.focusedTabsetId}${padding}`;
    const paddedLayout: RightSidebarLayoutState = {
      ...base,
      focusedTabsetId: tabsetId,
      root: { ...base.root, id: tabsetId } as RightSidebarLayoutState["root"],
    };
    const { sidebar, cleanup } = await setupRightSidebarView(() => {
      expect(updatePersistedState(layoutKey, paddedLayout)).toBe(true);
    });

    try {
      await createTerminalTab(sidebar);
      expect(await env.orpc.terminal.listSessions({ workspaceId })).toHaveLength(1);
      // The oversized layout lives in memory only; localStorage keeps the last layout that fit.
      expect(window.localStorage.getItem(layoutKey)).toContain(tabsetId);
      expect(window.localStorage.getItem(layoutKey)).not.toContain("terminal:");
    } finally {
      await cleanup();
    }
  }, 60_000);

  test("Cmd+T opens terminal and selects its tab", async () => {
    const { sidebar, cleanup } = await setupRightSidebarView(() => {
      // Clear any persisted state
      updatePersistedState(RIGHT_SIDEBAR_TAB_KEY, null);
      updatePersistedState(getRightSidebarLayoutKey(workspaceId), null);
    });

    try {
      // Verify no terminal tab exists initially
      const initialTerminalTab = sidebar.querySelector('[role="tab"][aria-controls*="terminal:"]');
      expect(initialTerminalTab).toBeNull();

      // Press Ctrl+T (Cmd+T on mac) to open a new terminal
      fireEvent.keyDown(window, { key: "t", ctrlKey: true });

      // Wait for the terminal tab to appear and become selected
      const terminalTab = await waitFor(
        () => {
          const tab = sidebar.querySelector('[role="tab"][aria-controls*="terminal:"]');
          if (!tab) throw new Error("Terminal tab not found after Cmd+T");
          return tab;
        },
        { timeout: 10_000 }
      );

      await waitFor(() => {
        expect(terminalTab.getAttribute("aria-selected")).toBe("true");
      });

      // Verify terminal panel is visible (not hidden)
      const terminalPanel = await waitFor(
        () => {
          const panel = sidebar.querySelector('[role="tabpanel"][id*="terminal"]:not([hidden])');
          if (!panel) throw new Error("Terminal panel not visible");
          return panel;
        },
        { timeout: 5_000 }
      );

      // Verify the terminal view is rendered inside the panel
      await waitFor(
        () => {
          const terminalView = terminalPanel.querySelector(".terminal-view");
          if (!terminalView) throw new Error("Terminal view not found");
        },
        { timeout: 5_000 }
      );

      // Note: Actual terminal focus cannot be reliably tested in happy-dom
      // because ghostty-web uses WebAssembly and complex browser APIs.
      // The autoFocus behavior is verified by the implementation passing
      // autoFocus={true} to TerminalView when the terminal is opened via keybind.
    } finally {
      await cleanup();
    }
  }, 60_000);
});
