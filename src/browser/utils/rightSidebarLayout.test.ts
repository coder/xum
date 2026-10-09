import { expect, test } from "bun:test";
import {
  getSideChatTabWorkspaceId,
  isTabType,
  makeSideChatTabType,
  type TabType,
} from "@/browser/types/rightSidebar";
import {
  addNewTabToTabset,
  addTabToFocusedTabset,
  closeTabInTabset,
  getTabRevealedByClose,
  collectAllTabsWithTabset,
  dockTabToEdge,
  getDefaultRightSidebarLayoutState,
  moveTabToTabset,
  openToolFromNewTab,
  parseRightSidebarLayoutState,
  removeTabEverywhere,
  reorderTabInTabset,
  selectOrAddTab,
  selectTabInFocusedTabset,
  splitFocusedTabset,
  type RightSidebarLayoutNode,
  type RightSidebarLayoutState,
} from "./rightSidebarLayout";

type Tabset = Extract<RightSidebarLayoutNode, { type: "tabset" }>;

function tabset(id: string, tabs: TabType[], activeTab: TabType = tabs[0]): Tabset {
  return { type: "tabset", id, tabs, activeTab };
}

function single(tabs: TabType[], activeTab: TabType = tabs[0]): RightSidebarLayoutState {
  return {
    version: 1,
    openTabsOnly: true,
    nextId: 2,
    focusedTabsetId: "tabset-1",
    root: tabset("tabset-1", tabs, activeTab),
  };
}

function split(left: Tabset, right: Tabset, focusedTabsetId = left.id): RightSidebarLayoutState {
  return {
    version: 1,
    openTabsOnly: true,
    nextId: 3,
    focusedTabsetId,
    root: {
      type: "split",
      id: "split-1",
      direction: "horizontal",
      sizes: [50, 50],
      children: [left, right],
    },
  };
}

function rootTabset(state: RightSidebarLayoutState): Tabset {
  if (state.root.type !== "tabset") throw new Error("expected tabset root");
  return state.root;
}

function children(state: RightSidebarLayoutState): [Tabset, Tabset] {
  if (state.root.type !== "split") throw new Error("expected split root");
  const [left, right] = state.root.children;
  if (left.type !== "tabset" || right.type !== "tabset") throw new Error("expected tabsets");
  return [left, right];
}

test("a new layout holds just the New tab, or the one requested tool", () => {
  expect(rootTabset(getDefaultRightSidebarLayoutState())).toMatchObject({
    tabs: ["new"],
    activeTab: "new",
  });
  expect(rootTabset(getDefaultRightSidebarLayoutState("review"))).toMatchObject({
    tabs: ["review"],
    activeTab: "review",
  });
});

test("invalid persisted data falls back to the New tab layout", () => {
  expect(rootTabset(parseRightSidebarLayoutState({ version: 3 })).tabs).toEqual(["new"]);
  expect(rootTabset(parseRightSidebarLayoutState(null, "goal")).tabs).toEqual(["goal"]);
});

test("removeTabEverywhere preserves identity when the tab is absent", () => {
  const state = single(["costs"]);
  expect(removeTabEverywhere(state, "browser")).toBe(state);
});

test("removing the last tab leaves the New tab", () => {
  const next = removeTabEverywhere(single(["costs"]), "costs");
  expect(rootTabset(next)).toMatchObject({ tabs: ["new"], activeTab: "new" });
});

test("selectTabInFocusedTabset adds missing tool and makes it active", () => {
  const s = selectTabInFocusedTabset(single(["costs"]), "terminal");
  expect(rootTabset(s)).toMatchObject({
    tabs: ["costs", "terminal"],
    activeTab: "terminal",
  });
});

test("adding a tool where the New tab is the only tab replaces it, even without activating", () => {
  const selected = selectOrAddTab(single(["new"]), "workflows");
  expect(rootTabset(selected)).toMatchObject({
    tabs: ["workflows"],
    activeTab: "workflows",
  });

  const background = addTabToFocusedTabset(single(["new"]), "terminal:s1", false);
  expect(rootTabset(background)).toMatchObject({
    tabs: ["terminal:s1"],
    activeTab: "terminal:s1",
  });
});

test("an activated tool replaces the New tab being viewed, at its position", () => {
  const s = selectOrAddTab(single(["costs", "new", "review"], "new"), "goal");
  expect(rootTabset(s)).toMatchObject({
    tabs: ["costs", "goal", "review"],
    activeTab: "goal",
  });
});

test("a background add keeps a New tab the user is looking at beside other tabs", () => {
  const s = addTabToFocusedTabset(single(["costs", "new"], "new"), "terminal:s1", false);
  expect(rootTabset(s)).toMatchObject({
    tabs: ["costs", "new", "terminal:s1"],
    activeTab: "new",
  });
});

test("addTabToFocusedTabset can add a tab without stealing focus", () => {
  const s1 = addTabToFocusedTabset(single(["costs", "review"]), "output", false);
  expect(rootTabset(s1)).toMatchObject({
    tabs: ["costs", "review", "output"],
    activeTab: "costs",
  });
});

test("openToolFromNewTab replaces the New tab in place and selects the tool", () => {
  const s = openToolFromNewTab(single(["costs", "new", "review"], "new"), "tabset-1", "timeline");
  expect(rootTabset(s)).toMatchObject({
    tabs: ["costs", "timeline", "review"],
    activeTab: "timeline",
  });
});

test("openToolFromNewTab selects a tool already open in the tabset and drops the New tab", () => {
  const s = openToolFromNewTab(single(["costs", "new"], "new"), "tabset-1", "costs");
  expect(rootTabset(s)).toMatchObject({ tabs: ["costs"], activeTab: "costs" });
});

test("openToolFromNewTab selects a tool open in another pane, closing the New tab's pane", () => {
  const s = openToolFromNewTab(
    split(tabset("tabset-1", ["review", "costs"]), tabset("tabset-2", ["new"]), "tabset-2"),
    "tabset-2",
    "costs"
  );
  expect(rootTabset(s)).toMatchObject({
    id: "tabset-1",
    tabs: ["review", "costs"],
    activeTab: "costs",
  });
  expect(s.focusedTabsetId).toBe("tabset-1");
});

test("a tabset holds at most one New tab", () => {
  const once = addNewTabToTabset(single(["costs"]), "tabset-1");
  const twice = addNewTabToTabset(selectOrAddTab(once, "costs"), "tabset-1");
  expect(rootTabset(twice)).toMatchObject({
    tabs: ["costs", "new"],
    activeTab: "new",
  });

  const parsed = parseRightSidebarLayoutState(single(["new", "costs", "new"], "costs"));
  expect(rootTabset(parsed).tabs).toEqual(["new", "costs"]);
});

test("each pane can have its own New tab, and Ctrl/Cmd+number slots skip them", () => {
  const s = addNewTabToTabset(
    split(tabset("tabset-1", ["costs", "new"]), tabset("tabset-2", ["review"])),
    "tabset-2"
  );
  const [left, right] = children(s);
  expect(left.tabs).toContain("new");
  expect(right).toMatchObject({ tabs: ["review", "new"], activeTab: "new" });
  expect(collectAllTabsWithTabset(s.root).map((t) => t.tab)).toEqual(["costs", "review"]);
});

test("closeTabInTabset closes one pane's New tab without touching another's", () => {
  const s = closeTabInTabset(
    split(tabset("tabset-1", ["costs", "new"]), tabset("tabset-2", ["review", "new"])),
    "tabset-2",
    "new"
  );
  const [left, right] = children(s);
  expect(left.tabs).toEqual(["costs", "new"]);
  expect(right.tabs).toEqual(["review"]);
});

test("closing the last tab of the only pane leaves the New tab; closing that New tab is a no-op", () => {
  const closed = closeTabInTabset(single(["review"]), "tabset-1", "review");
  expect(rootTabset(closed)).toMatchObject({ tabs: ["new"], activeTab: "new" });
  expect(closeTabInTabset(closed, "tabset-1", "new")).toBe(closed);
});

test("getTabRevealedByClose names the terminal a close uncovers, so it can take focus", () => {
  const close = (prev: RightSidebarLayoutState, tabsetId: string, tab: TabType) =>
    getTabRevealedByClose(prev, closeTabInTabset(prev, tabsetId, tab), tabsetId, tab);

  // The pane's next tab comes on screen.
  expect(close(single(["costs", "terminal:t1"], "costs"), "tabset-1", "costs")).toBe("terminal:t1");
  // The pane closed: the focused pane's active tab is what the user now looks at.
  expect(
    close(
      split(tabset("tabset-1", ["new"]), tabset("tabset-2", ["terminal:t2"]), "tabset-2"),
      "tabset-1",
      "new"
    )
  ).toBe("terminal:t2");
  // Closing a background tab uncovers nothing, so focus stays where it is.
  expect(close(single(["costs", "review"], "review"), "tabset-1", "costs")).toBeNull();
});

test("closing the last tab of one pane collapses the split into the other pane", () => {
  const s = closeTabInTabset(
    split(tabset("tabset-1", ["costs"]), tabset("tabset-2", ["review"]), "tabset-1"),
    "tabset-1",
    "costs"
  );
  expect(rootTabset(s).id).toBe("tabset-2");
  expect(s.focusedTabsetId).toBe("tabset-2");
});

test("closing the active tab selects its neighbor", () => {
  const s = closeTabInTabset(single(["costs", "review", "goal"], "review"), "tabset-1", "review");
  expect(rootTabset(s)).toMatchObject({
    tabs: ["costs", "goal"],
    activeTab: "goal",
  });
});

test("splitting a one-tab pane gives the new pane a New tab", () => {
  const [left, right] = children(splitFocusedTabset(single(["review"]), "vertical"));
  expect(left.tabs).toEqual(["review"]);
  expect(right).toMatchObject({ tabs: ["new"], activeTab: "new" });
});

test("splitting a multi-tab pane moves the active tab into the new pane", () => {
  const [left, right] = children(
    splitFocusedTabset(single(["costs", "review"], "review"), "horizontal")
  );
  expect(left.tabs).toEqual(["costs"]);
  expect(right.tabs).toEqual(["review"]);
});

test("moveTabToTabset moves tab between tabsets", () => {
  const s = moveTabToTabset(
    split(tabset("tabset-1", ["costs", "goal"]), tabset("tabset-2", ["review"])),
    "costs",
    "tabset-1",
    "tabset-2"
  );
  const [, right] = children(s);
  expect(right).toMatchObject({
    tabs: ["review", "costs"],
    activeTab: "costs",
  });
});

test("moveTabToTabset into a pane holding only a New tab replaces it", () => {
  const s = moveTabToTabset(
    split(tabset("tabset-1", ["costs", "goal"]), tabset("tabset-2", ["new"])),
    "costs",
    "tabset-1",
    "tabset-2"
  );
  const [, right] = children(s);
  expect(right).toMatchObject({ tabs: ["costs"], activeTab: "costs" });
});

test("moveTabToTabset removes empty source tabset", () => {
  const s = moveTabToTabset(
    split(tabset("tabset-1", ["costs"]), tabset("tabset-2", ["review", "terminal"])),
    "costs",
    "tabset-1",
    "tabset-2"
  );
  expect(rootTabset(s).tabs).toEqual(["review", "terminal", "costs"]);
});

test("reorderTabInTabset reorders tabs within a tabset", () => {
  const s1 = reorderTabInTabset(single(["costs", "review"]), "tabset-1", 0, 1);
  expect(rootTabset(s1)).toMatchObject({
    tabs: ["review", "costs"],
    activeTab: "costs",
  });
});

test("dockTabToEdge splits a tabset and moves the dragged tab into the new pane", () => {
  const s1 = dockTabToEdge(single(["costs", "review"]), "review", "tabset-1", "tabset-1", "bottom");
  expect(s1.root.type === "split" && s1.root.direction).toBe("horizontal");
  const [top, bottom] = children(s1);
  expect(bottom).toMatchObject({ tabs: ["review"], activeTab: "review" });
  expect(top.tabs).toEqual(["costs"]);
});

test("dragging out the last tab leaves a New tab in the original pane", () => {
  const [left, right] = children(
    dockTabToEdge(single(["costs"]), "costs", "tabset-1", "tabset-1", "right")
  );
  expect(right.tabs).toEqual(["costs"]);
  expect(left).toMatchObject({ tabs: ["new"], activeTab: "new" });
});

test("dockTabToEdge removes an empty source tabset when docking into another tabset", () => {
  const s1 = dockTabToEdge(
    split(tabset("tabset-1", ["costs"]), tabset("tabset-2", ["review"])),
    "costs",
    "tabset-1",
    "tabset-2",
    "left"
  );
  const [left, right] = children(s1);
  expect(left.tabs).toEqual(["costs"]);
  expect(right.tabs).toEqual(["review"]);
});

// --- Persisted layouts ---

test("unmarked (legacy) layouts drop auto-added tools but keep the active tab, Output, terminals, side chats", () => {
  const raw = {
    version: 1,
    nextId: 3,
    focusedTabsetId: "tabset-1",
    root: {
      type: "split",
      id: "split-1",
      direction: "horizontal",
      sizes: [50, 50],
      children: [
        {
          type: "tabset",
          id: "tabset-1",
          tabs: ["costs", "review", "output", "instructions", "terminal:abc", "goal", "side:sc"],
          activeTab: "review",
        },
        {
          type: "tabset",
          id: "tabset-2",
          tabs: ["workflows", "timeline"],
          activeTab: "timeline",
        },
      ],
    },
  };

  const result = parseRightSidebarLayoutState(raw);
  // Still version 1 (readable by older builds), marked as migrated.
  expect(result).toMatchObject({ version: 1, openTabsOnly: true });
  const [left, right] = children(result);
  expect(left).toMatchObject({
    // Output was never auto-added, so the user opened it: it stays.
    tabs: ["review", "output", "terminal:abc", "side:sc"],
    activeTab: "review",
  });
  expect(right).toMatchObject({ tabs: ["timeline"], activeTab: "timeline" });
});

test("a legacy tabset whose active tab is missing becomes a New tab when nothing is kept", () => {
  const raw = {
    version: 1,
    nextId: 2,
    focusedTabsetId: "tabset-1",
    root: {
      type: "tabset",
      id: "tabset-1",
      tabs: ["costs", "review"],
      activeTab: "goal",
    },
  };
  expect(rootTabset(parseRightSidebarLayoutState(raw))).toMatchObject({
    tabs: ["new"],
    activeTab: "new",
  });
});

test("the legacy migration is idempotent", () => {
  const raw = {
    version: 1,
    nextId: 2,
    focusedTabsetId: "tabset-1",
    root: {
      type: "tabset",
      id: "tabset-1",
      tabs: ["costs", "terminal:abc", "review"],
      activeTab: "costs",
    },
  };
  const once = parseRightSidebarLayoutState(raw);
  const twice = parseRightSidebarLayoutState(once);
  expect(twice).toBe(once);
  expect(rootTabset(once).tabs).toEqual(["costs", "terminal:abc"]);
});

test("marked layouts are used as-is: no tools are re-added", () => {
  const raw = single(["goal"]);
  expect(parseRightSidebarLayoutState(raw)).toBe(raw);
});

test("parseRightSidebarLayoutState strips removed static tabs", () => {
  const raw = {
    version: 1,
    openTabsOnly: true,
    nextId: 2,
    focusedTabsetId: "tabset-1",
    root: {
      type: "tabset",
      id: "tabset-1",
      tabs: ["review", "costs", "stats", "explorer", "file:a.ts"],
      activeTab: "stats",
    },
  };
  // "stats" maps to its replacement, "costs", rather than the first tab.
  expect(rootTabset(parseRightSidebarLayoutState(raw))).toMatchObject({
    tabs: ["review", "costs"],
    activeTab: "costs",
  });
});

test("a tabset holding only removed tabs becomes a New tab", () => {
  const raw = {
    version: 1,
    openTabsOnly: true,
    nextId: 2,
    focusedTabsetId: "tabset-1",
    root: {
      type: "tabset",
      id: "tabset-1",
      tabs: ["stats", "explorer"],
      activeTab: "stats",
    },
  };
  expect(rootTabset(parseRightSidebarLayoutState(raw))).toMatchObject({
    tabs: ["new"],
    activeTab: "new",
  });
});

test("parseRightSidebarLayoutState keeps an open /side chat tab", () => {
  const raw = single(["costs", "terminal:abc", "side:side-ws"], "side:side-ws");
  const result = rootTabset(parseRightSidebarLayoutState(raw));
  expect(result.tabs).toContain("terminal:abc");
  expect(getSideChatTabWorkspaceId(result.activeTab)).toBe("side-ws");
});

test("tab type validation accepts the New tab and rejects a bare side: prefix", () => {
  expect(isTabType("new")).toBe(true);
  expect(isTabType("side:")).toBe(false);
  expect(isTabType(makeSideChatTabType("side-ws"))).toBe(true);
});

test("marked layouts written by this build still validate as version 1 for older builds", () => {
  // Older builds accept only version 1 and ignore unknown keys; a version bump would make
  // them reset the layout (losing splits and tab order) after a downgrade.
  const written = parseRightSidebarLayoutState(null);
  expect(written.version).toBe(1);
  expect(written.openTabsOnly).toBe(true);
});

test("openToolFromNewTab prefers the tool already in its own pane over an earlier pane's copy", () => {
  // Both panes hold Stats (possible after drags); the launcher in pane 2 must select pane 2's.
  const s = openToolFromNewTab(
    split(tabset("tabset-1", ["costs"]), tabset("tabset-2", ["costs", "new"], "new"), "tabset-2"),
    "tabset-2",
    "costs"
  );
  const [left, right] = children(s);
  expect(left.tabs).toEqual(["costs"]);
  expect(right).toMatchObject({ tabs: ["costs"], activeTab: "costs" });
  expect(s.focusedTabsetId).toBe("tabset-2");
});

test("openToolFromNewTab opens in the focused pane when the launcher's pane is gone", () => {
  // A terminal arrives only after its session is created; by then the launcher pane may have
  // been closed. The session must still get a tab.
  const s = openToolFromNewTab(single(["costs", "review"]), "tabset-gone", "terminal:s1");
  expect(rootTabset(s)).toMatchObject({
    tabs: ["costs", "review", "terminal:s1"],
    activeTab: "terminal:s1",
  });
});
