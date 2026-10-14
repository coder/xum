import { describe, expect, test } from "bun:test";
import { getAppViewTabKey, isTabType } from "@/browser/types/rightSidebar";
import {
  collectAllTabs,
  findTabset,
  parseRightSidebarLayoutState,
  splitFocusedTabset,
  type RightSidebarLayoutState,
} from "@/browser/utils/rightSidebarLayout";
import {
  appViewTabFor,
  appViewTabToolCallId,
  liveAppViewTabs,
  MAX_LIVE_APP_VIEW_TABS,
  nextRecentAppViewTabs,
  withAppViewTab,
} from "./appViewTabs";

const rootTabset = (state: RightSidebarLayoutState) => {
  if (state.root.type !== "tabset") throw new Error("expected a single tabset");
  return state.root;
};

describe("app view tabs", () => {
  test("the tab type uses the view key and survives a persistence round trip", () => {
    const tab = appViewTabFor("call-7");
    expect(tab).toBe("app:mcp-app:call-7");
    expect(getAppViewTabKey(tab)).toBe("mcp-app:call-7");
    expect(appViewTabToolCallId(tab)).toBe("call-7");
    expect(isTabType("app:")).toBe(false);
    // A key that is not a view key parses as a tab but shows no view.
    expect(appViewTabToolCallId("app:other")).toBeNull();

    const opened = withAppViewTab(parseRightSidebarLayoutState(null), "call-7");
    const restored = parseRightSidebarLayoutState(JSON.parse(JSON.stringify(opened)));
    expect(rootTabset(restored).activeTab).toBe(tab);
    expect(collectAllTabs(restored.root)).toContain(tab);
  });

  test("opening a view that has a tab focuses that one tab, even in another pane", () => {
    let state = withAppViewTab(parseRightSidebarLayoutState(null), "call-1");
    // Split: focus moves to a new pane; the view's tab stays in the first one.
    const firstPane = state.focusedTabsetId;
    state = splitFocusedTabset(state, "horizontal");
    expect(state.focusedTabsetId).not.toBe(firstPane);
    state = withAppViewTab(state, "call-1");
    const tabs = collectAllTabs(state.root);
    expect(tabs.filter((tab) => tab === appViewTabFor("call-1"))).toHaveLength(1);
    expect(state.focusedTabsetId).toBe(firstPane);
    const focused = findTabset(state.root, state.focusedTabsetId);
    expect(focused?.type === "tabset" && focused.activeTab).toBe(appViewTabFor("call-1"));
  });

  test("only the most recently active app tabs stay mounted", () => {
    const recent = ["a", "b", "c", "d"].map(appViewTabFor);
    const live = liveAppViewTabs(recent, [...recent].reverse());
    expect(live).toEqual(recent.slice(0, MAX_LIVE_APP_VIEW_TABS));
    // A closed tab drops out.
    expect(liveAppViewTabs(recent, [recent[1]])).toEqual([recent[1]]);
  });

  test("the stored activation order drops closed tabs and stays bounded", () => {
    const opened = Array.from({ length: 10 }, (_, i) => appViewTabFor(`call-${i}`));
    let recent: ReturnType<typeof nextRecentAppViewTabs> = [];
    // Open and activate many views; each one closes the one before it.
    for (const tab of opened) recent = nextRecentAppViewTabs(recent, tab, [tab, "costs"]);
    expect(recent).toEqual([opened[9]]);
    // With every tab still open, only the newest few are kept, newest first.
    for (const tab of opened) recent = nextRecentAppViewTabs(recent, tab, opened);
    expect(recent).toEqual(opened.slice(-MAX_LIVE_APP_VIEW_TABS).reverse());
  });

  test("a restored layout keeps only the first copy of an app tab", () => {
    const tab = appViewTabFor("call-dup");
    const restored = parseRightSidebarLayoutState({
      version: 1,
      openTabsOnly: true,
      nextId: 3,
      focusedTabsetId: "tabset-2",
      root: {
        type: "split",
        id: "split-1",
        direction: "horizontal",
        sizes: [50, 50],
        children: [
          { type: "tabset", id: "tabset-1", tabs: ["costs", tab, tab], activeTab: tab },
          { type: "tabset", id: "tabset-2", tabs: [tab, "review"], activeTab: tab },
        ],
      },
    });
    expect(collectAllTabs(restored.root).filter((t) => t === tab)).toHaveLength(1);
    const first = findTabset(restored.root, "tabset-1");
    const second = findTabset(restored.root, "tabset-2");
    expect(first?.type === "tabset" && first.tabs).toEqual(["costs", tab]);
    expect(second?.type === "tabset" && [second.tabs, second.activeTab]).toEqual([
      ["review"],
      "review",
    ]);
  });
});
