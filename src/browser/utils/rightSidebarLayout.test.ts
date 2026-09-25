import { expect, test } from "bun:test";
import {
  addTabToFocusedTabset,
  addToolToFocusedTabset,
  dockTabToEdge,
  getDefaultRightSidebarLayoutState,
  moveTabToTabset,
  parseRightSidebarLayoutState,
  removeTabEverywhere,
  reorderTabInTabset,
  selectTabInFocusedTabset,
  splitFocusedTabset,
  type RightSidebarLayoutState,
} from "./rightSidebarLayout";

test("default layout includes Instructions alongside Stats and Review", () => {
  const state = getDefaultRightSidebarLayoutState("costs");
  expect(state.root.type).toBe("tabset");
  if (state.root.type !== "tabset") throw new Error("expected tabset");

  expect(state.root.tabs).toContain("costs");
  expect(state.root.tabs).toContain("review");
  expect(state.root.tabs).toContain("instructions");
});

test("removeTabEverywhere preserves identity when the tab is absent", () => {
  const state = getDefaultRightSidebarLayoutState("costs");
  const withoutBrowser = removeTabEverywhere(state, "browser");

  expect(withoutBrowser).toBe(state);
});

test("selectTabInFocusedTabset adds missing tool and makes it active", () => {
  let s = getDefaultRightSidebarLayoutState("costs");
  // Start with a layout that only has costs.
  s = {
    ...s,
    root: { type: "tabset", id: "tabset-1", tabs: ["costs"], activeTab: "costs" },
  };

  s = selectTabInFocusedTabset(s, "terminal");
  expect(s.root.type).toBe("tabset");
  if (s.root.type !== "tabset") throw new Error("expected tabset");
  expect(s.root.tabs).toEqual(["costs", "terminal"]);
  expect(s.root.activeTab).toBe("terminal");
});

test("splitFocusedTabset moves active tab when possible (no empty tabsets)", () => {
  const s0 = getDefaultRightSidebarLayoutState("terminal");
  const s1 = splitFocusedTabset(s0, "horizontal");
  expect(s1.root.type).toBe("split");
  if (s1.root.type !== "split") throw new Error("expected split");
  expect(s1.root.children[0].type).toBe("tabset");
  expect(s1.root.children[1].type).toBe("tabset");

  const left = s1.root.children[0];
  const right = s1.root.children[1];
  if (left.type !== "tabset" || right.type !== "tabset") throw new Error("expected tabsets");

  expect(left.tabs.length).toBeGreaterThan(0);
  expect(right.tabs.length).toBeGreaterThan(0);
});

test("splitFocusedTabset avoids empty by spawning a neighbor tool for 1-tab tabsets", () => {
  let s = getDefaultRightSidebarLayoutState("costs");
  s = {
    ...s,
    root: { type: "tabset", id: "tabset-1", tabs: ["review"], activeTab: "review" },
  };

  const s1 = splitFocusedTabset(s, "vertical");
  expect(s1.root.type).toBe("split");
  if (s1.root.type !== "split") throw new Error("expected split");

  const left = s1.root.children[0];
  const right = s1.root.children[1];
  if (left.type !== "tabset" || right.type !== "tabset") throw new Error("expected tabsets");

  expect(left.tabs).toEqual(["review"]);
  expect(right.tabs.length).toBe(1);
  expect(right.tabs[0]).not.toBe("review");
});

test("addToolToFocusedTabset is an alias of selectTabInFocusedTabset", () => {
  const s0 = getDefaultRightSidebarLayoutState("costs");
  const s1 = addToolToFocusedTabset(s0, "review");
  expect(JSON.stringify(s1)).toContain("review");
});

test("addTabToFocusedTabset can add a tab without stealing focus", () => {
  const s0: RightSidebarLayoutState = {
    version: 1,
    nextId: 2,
    focusedTabsetId: "tabset-1",
    root: { type: "tabset", id: "tabset-1", tabs: ["costs", "review"], activeTab: "costs" },
  };

  const s1 = addTabToFocusedTabset(s0, "output", false);

  expect(s1.root.type).toBe("tabset");
  if (s1.root.type !== "tabset") throw new Error("expected tabset");
  expect(s1.root.tabs).toEqual(["costs", "review", "output"]);
  expect(s1.root.activeTab).toBe("costs");
});

test("moveTabToTabset moves tab between tabsets", () => {
  // Create a split layout with two tabsets
  const s0 = getDefaultRightSidebarLayoutState("costs");
  const s1 = splitFocusedTabset(s0, "horizontal");
  expect(s1.root.type).toBe("split");
  if (s1.root.type !== "split") throw new Error("expected split");

  const left = s1.root.children[0];
  const right = s1.root.children[1];
  if (left.type !== "tabset" || right.type !== "tabset") throw new Error("expected tabsets");

  // Move costs from left to right
  const s2 = moveTabToTabset(s1, "costs", left.id, right.id);
  expect(s2.root.type).toBe("split");
  if (s2.root.type !== "split") throw new Error("expected split");

  const newLeft = s2.root.children[0];
  const newRight = s2.root.children[1];
  if (newLeft.type !== "tabset" || newRight.type !== "tabset") throw new Error("expected tabsets");

  expect(newRight.tabs).toContain("costs");
  expect(newRight.activeTab).toBe("costs");
});

test("moveTabToTabset removes empty source tabset", () => {
  // Create a split where one tabset has only one tab
  let s: RightSidebarLayoutState = {
    version: 1,
    nextId: 3,
    focusedTabsetId: "tabset-1",
    root: {
      type: "split",
      id: "split-1",
      direction: "horizontal",
      sizes: [50, 50],
      children: [
        { type: "tabset", id: "tabset-1", tabs: ["costs"], activeTab: "costs" },
        { type: "tabset", id: "tabset-2", tabs: ["review", "terminal"], activeTab: "review" },
      ],
    },
  };

  // Move the only tab from tabset-1 to tabset-2
  s = moveTabToTabset(s, "costs", "tabset-1", "tabset-2");

  // The split should be replaced by the remaining tabset
  expect(s.root.type).toBe("tabset");
  if (s.root.type !== "tabset") throw new Error("expected tabset");
  expect(s.root.tabs).toContain("costs");
  expect(s.root.tabs).toContain("review");
  expect(s.root.tabs).toContain("terminal");
});

test("reorderTabInTabset reorders tabs within a tabset", () => {
  // Use an explicit minimal layout so this test exercises only reordering,
  // independent of the registry's `inDefaultLayout` set.
  const s0: RightSidebarLayoutState = {
    version: 1,
    nextId: 2,
    focusedTabsetId: "tabset-1",
    root: { type: "tabset", id: "tabset-1", tabs: ["costs", "review"], activeTab: "costs" },
  };
  const s1 = reorderTabInTabset(s0, "tabset-1", 0, 1);

  expect(s1.root.type).toBe("tabset");
  if (s1.root.type !== "tabset") throw new Error("expected tabset");

  expect(s1.root.tabs).toEqual(["review", "costs"]);
  expect(s1.root.activeTab).toBe("costs");
});

test("dockTabToEdge splits a tabset and moves the dragged tab into the new pane", () => {
  // Default layout has ["costs", "review"]; drag review into a bottom split
  const s0 = getDefaultRightSidebarLayoutState("costs");

  const s1 = dockTabToEdge(s0, "review", "tabset-1", "tabset-1", "bottom");

  expect(s1.root.type).toBe("split");
  if (s1.root.type !== "split") throw new Error("expected split");

  expect(s1.root.direction).toBe("horizontal");

  const top = s1.root.children[0];
  const bottom = s1.root.children[1];
  if (top.type !== "tabset" || bottom.type !== "tabset") throw new Error("expected tabsets");

  expect(bottom.tabs).toEqual(["review"]);
  expect(bottom.activeTab).toBe("review");
  expect(top.tabs).not.toContain("review");
});

test("dockTabToEdge avoids empty tabsets when dragging out the last tab", () => {
  const s0: RightSidebarLayoutState = {
    version: 1,
    nextId: 2,
    focusedTabsetId: "tabset-1",
    root: { type: "tabset", id: "tabset-1", tabs: ["costs"], activeTab: "costs" },
  };

  const s1 = dockTabToEdge(s0, "costs", "tabset-1", "tabset-1", "right");
  expect(s1.root.type).toBe("split");
  if (s1.root.type !== "split") throw new Error("expected split");

  expect(s1.root.direction).toBe("vertical");

  const left = s1.root.children[0];
  const right = s1.root.children[1];
  if (left.type !== "tabset" || right.type !== "tabset") throw new Error("expected tabsets");

  // The dragged tab goes into the new right pane.
  expect(right.tabs).toEqual(["costs"]);

  // The original pane gets a fallback tool instead of going empty.
  expect(left.tabs.length).toBe(1);
  expect(left.tabs[0]).not.toBe("costs");
});

test("dockTabToEdge removes an empty source tabset when docking into another tabset", () => {
  const s0: RightSidebarLayoutState = {
    version: 1,
    nextId: 3,
    focusedTabsetId: "tabset-1",
    root: {
      type: "split",
      id: "split-1",
      direction: "horizontal",
      sizes: [50, 50],
      children: [
        { type: "tabset", id: "tabset-1", tabs: ["costs"], activeTab: "costs" },
        { type: "tabset", id: "tabset-2", tabs: ["review"], activeTab: "review" },
      ],
    },
  };

  // Dock the costs tab to the left edge of tabset-2.
  const s1 = dockTabToEdge(s0, "costs", "tabset-1", "tabset-2", "left");

  // The original source tabset should be removed and the root should now be the new split.
  expect(s1.root.type).toBe("split");
  if (s1.root.type !== "split") throw new Error("expected split");

  const left = s1.root.children[0];
  const right = s1.root.children[1];
  if (left.type !== "tabset" || right.type !== "tabset") throw new Error("expected tabsets");

  expect(left.tabs).toEqual(["costs"]);
  expect(right.tabs).toEqual(["review"]);
});

test("parseRightSidebarLayoutState strips removed static tabs from persisted layouts", () => {
  // Simulate a persisted layout that still contains removed tabs
  const raw = {
    version: 1,
    nextId: 2,
    focusedTabsetId: "tabset-1",
    root: {
      type: "tabset",
      id: "tabset-1",
      tabs: ["costs", "review", "stats", "explorer"],
      activeTab: "costs",
    },
  };

  const result = parseRightSidebarLayoutState(raw, "costs");

  // Should parse successfully (not fall back to defaults)
  expect(result.root.type).toBe("tabset");
  if (result.root.type !== "tabset") throw new Error("expected tabset");

  // Removed tabs ("stats", "explorer") are stripped. New default-layout tabs
  // declared in the registry (`inDefaultLayout: true`) are auto-injected so
  // upgrades flow through without the user having to add them by hand — see
  // `ensureDefaultLayoutTabs` in rightSidebarLayout.ts.
  expect(result.root.tabs).toContain("costs");
  expect(result.root.tabs).toContain("review");
  expect(result.root.tabs).not.toContain("stats");
  expect(result.root.tabs).not.toContain("explorer");
  expect(result.root.activeTab).toBe("costs");
});

test("parseRightSidebarLayoutState falls back activeTab when stats was active", () => {
  const raw = {
    version: 1,
    nextId: 2,
    focusedTabsetId: "tabset-1",
    root: {
      type: "tabset",
      id: "tabset-1",
      tabs: ["costs", "stats", "review", "explorer"],
      activeTab: "stats",
    },
  };

  const result = parseRightSidebarLayoutState(raw, "costs");

  expect(result.root.type).toBe("tabset");
  if (result.root.type !== "tabset") throw new Error("expected tabset");

  // "stats" stripped; activeTab should fall back to the first remaining tab.
  expect(result.root.tabs).toContain("costs");
  expect(result.root.tabs).toContain("review");
  expect(result.root.tabs).not.toContain("stats");
  expect(result.root.activeTab).toBe("costs");
});
test("parseRightSidebarLayoutState maps stats activeTab to costs even when reordered", () => {
  // Tabs reordered so "costs" is NOT first — activeTab should still map to "costs"
  const raw = {
    version: 1,
    nextId: 2,
    focusedTabsetId: "tabset-1",
    root: {
      type: "tabset",
      id: "tabset-1",
      tabs: ["review", "costs", "stats", "explorer"],
      activeTab: "stats",
    },
  };

  const result = parseRightSidebarLayoutState(raw, "costs");

  expect(result.root.type).toBe("tabset");
  if (result.root.type !== "tabset") throw new Error("expected tabset");

  // "stats"/"explorer" stripped; activeTab should map to "costs" (semantic
  // replacement), not "review". Default-layout tabs (`inDefaultLayout: true`)
  // may be auto-injected by `ensureDefaultLayoutTabs`, so we assert presence
  // of the original tabs rather than full-array equality.
  expect(result.root.tabs).toContain("review");
  expect(result.root.tabs).toContain("costs");
  expect(result.root.tabs).not.toContain("stats");
  expect(result.root.tabs).not.toContain("explorer");
  expect(result.root.activeTab).toBe("costs");
});

test("parseRightSidebarLayoutState handles split layouts with removed tabs", () => {
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
          tabs: ["costs", "stats", "explorer"],
          activeTab: "costs",
        },
        {
          type: "tabset",
          id: "tabset-2",
          tabs: ["review", "stats"],
          activeTab: "stats",
        },
      ],
    },
  };

  const result = parseRightSidebarLayoutState(raw, "costs");

  // Both tabsets should have removed tabs stripped
  expect(result.root.type).toBe("split");
  if (result.root.type !== "split") throw new Error("expected split");

  const left = result.root.children[0];
  const right = result.root.children[1];

  expect(left.type).toBe("tabset");
  expect(right.type).toBe("tabset");

  if (left.type !== "tabset" || right.type !== "tabset") throw new Error("expected tabsets");

  // The left tabset still contains "costs" (and only "costs" of the originals);
  // any additional default-layout tabs are auto-appended by
  // `ensureDefaultLayoutTabs`. The right tabset is unaffected (it doesn't host
  // the first tabset, which is where defaults land).
  expect(left.tabs).toContain("costs");
  expect(left.tabs).not.toContain("stats");
  expect(left.tabs).not.toContain("explorer");
  expect(left.activeTab).toBe("costs");
  expect(right.tabs).toEqual(["review"]);
  expect(right.activeTab).toBe("review");
});

test("parseRightSidebarLayoutState auto-adds missing default-layout tabs from the registry", () => {
  // A minimal pre-existing layout that pre-dates the addition of new default
  // tabs. The migration should add every `inDefaultLayout: true` tab from the
  // registry to the first tabset, leaving the active tab untouched.
  const raw: RightSidebarLayoutState = {
    version: 1,
    nextId: 2,
    focusedTabsetId: "tabset-1",
    root: { type: "tabset", id: "tabset-1", tabs: ["costs"], activeTab: "costs" },
  };

  const result = parseRightSidebarLayoutState(raw, "costs");

  expect(result.root.type).toBe("tabset");
  if (result.root.type !== "tabset") throw new Error("expected tabset");

  // Confirms the migration injects every default tab without re-ordering
  // existing ones — pre-existing "costs" stays at index 0.
  expect(result.root.tabs[0]).toBe("costs");
  expect(result.root.tabs).toContain("costs");
  expect(result.root.tabs).toContain("review");
  expect(result.root.tabs).toContain("instructions");
  expect(result.root.activeTab).toBe("costs");
});
