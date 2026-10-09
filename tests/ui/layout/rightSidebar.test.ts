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
import { fireEvent, waitFor, within } from "@testing-library/react";

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
import { cleanupView, setupWorkspaceView } from "../helpers";
import {
  RIGHT_SIDEBAR_COLLAPSED_KEY,
  RIGHT_SIDEBAR_TAB_KEY,
  RIGHT_SIDEBAR_WIDTH_KEY,
  getPersistedKeyRegistration,
  getRightSidebarLayoutKey,
  getTerminalTitlesKey,
} from "@/common/constants/storage";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
// RightSidebarLayoutState used for initial setup via persisted-state helpers - acceptable for test fixtures
import {
  getDefaultRightSidebarLayoutState,
  type RightSidebarLayoutState,
} from "@/browser/utils/rightSidebarLayout";
import type { TabType } from "@/browser/types/rightSidebar";
import { BROWSER_VIEWPORT_ATTR } from "@/browser/utils/ui/keybinds";

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
    updatePersistedState(RIGHT_SIDEBAR_COLLAPSED_KEY, null);
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
      return { view, sidebar, cleanup: () => cleanupView(view, cleanupDom) };
    } catch (error) {
      await cleanupView(view, cleanupDom);
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

  /** "+" opens the New tab; its launcher lists the tools. */
  async function openLauncher(sidebar: HTMLElement): Promise<HTMLElement> {
    fireEvent.click(
      await findRequiredElement(sidebar, 'button[aria-label="New tab"]', "New tab button not found")
    );
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
      updatePersistedState(RIGHT_SIDEBAR_COLLAPSED_KEY, false);
    });

    try {
      // Verify tabs are visible (expanded state)
      await waitFor(() => {
        const tablist = sidebar.querySelector('[role="tablist"]');
        if (!tablist) throw new Error("Tablist should be visible when expanded");
      });

      const collapseButton = await findRequiredElement(
        sidebar,
        'button[aria-label*="ollapse"]',
        "Collapse button not found"
      );
      fireEvent.click(collapseButton);

      // Wait for collapse - tablist should not be rendered
      await waitFor(() => {
        const tablist = sidebar.querySelector('[role="tablist"]');
        if (tablist) throw new Error("Tablist should be hidden when collapsed");
      });

      // Re-query sidebar and find expand button (sidebar reference may be stale after collapse)
      const collapsedSidebar = view.container.querySelector(
        '[role="complementary"][aria-label="Workspace insights"]'
      )!;
      expect(collapsedSidebar).toBeTruthy();
      const expandButton = collapsedSidebar.querySelector('button[aria-label="Expand sidebar"]')!;
      expect(expandButton).toBeTruthy();
      fireEvent.click(expandButton);

      // Wait for expand - tablist should be visible again
      await waitFor(() => {
        const tablist = sidebar.querySelector('[role="tablist"]');
        if (!tablist) throw new Error("Tablist should be visible after expand");
      });
    } finally {
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

      // Create a terminal via "+" (New tab) and its launcher, and verify its content
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
      fireEvent.mouseDown(resizeHandle, { clientX: 800 });
      fireEvent.mouseMove(document, { clientX: 830 });
      fireEvent.mouseUp(document);

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
      fireEvent.mouseDown(resizeHandle, { clientX: 800 });
      fireEvent.mouseMove(document, { clientX: 830 });
      fireEvent.mouseUp(document);

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
      fireEvent.mouseDown(resizeHandle, { clientX: 800 });
      fireEvent.mouseMove(document, { clientX: 900 });
      fireEvent.mouseUp(document);

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

      fireEvent.mouseDown(resizeHandle, { clientX: 1000 });
      // Move far left to try to exceed max width.
      fireEvent.mouseMove(document, { clientX: 0 });
      fireEvent.mouseUp(document);

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
