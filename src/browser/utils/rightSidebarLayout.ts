import {
  getSideChatTabWorkspaceId,
  isNewTab,
  isTabType,
  isTerminalTab,
  NEW_TAB,
  type TabType,
} from "@/browser/types/rightSidebar";

export type RightSidebarLayoutNode =
  | {
      type: "split";
      id: string;
      direction: "horizontal" | "vertical";
      sizes: [number, number];
      children: [RightSidebarLayoutNode, RightSidebarLayoutNode];
    }
  | {
      type: "tabset";
      id: string;
      tabs: TabType[];
      activeTab: TabType;
    };

type TabsetNode = Extract<RightSidebarLayoutNode, { type: "tabset" }>;

function isLayoutNode(value: unknown): value is RightSidebarLayoutNode {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;

  if (v.type === "tabset") {
    return (
      typeof v.id === "string" &&
      Array.isArray(v.tabs) &&
      v.tabs.every((t) => isTabType(t)) &&
      isTabType(v.activeTab)
    );
  }

  if (v.type === "split") {
    if (typeof v.id !== "string") return false;
    if (v.direction !== "horizontal" && v.direction !== "vertical") return false;
    if (!Array.isArray(v.sizes) || v.sizes.length !== 2) return false;
    if (typeof v.sizes[0] !== "number" || typeof v.sizes[1] !== "number") return false;
    if (!Array.isArray(v.children) || v.children.length !== 2) return false;
    return isLayoutNode(v.children[0]) && isLayoutNode(v.children[1]);
  }

  return false;
}

/** A persisted layout of any supported version (parse migrates it to the current one). */
type PersistedRightSidebarLayoutState = Omit<RightSidebarLayoutState, "version"> & {
  version: 1 | 2;
};

/** Accepts version 1 (pre "New tab") and version 2 layouts; parse always emits version 2. */
export function isRightSidebarLayoutState(
  value: unknown
): value is PersistedRightSidebarLayoutState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 && v.version !== 2) return false;
  if (typeof v.nextId !== "number") return false;
  if (typeof v.focusedTabsetId !== "string") return false;
  if (!isLayoutNode(v.root)) return false;
  return findTabset(v.root, v.focusedTabsetId) !== null;
}

/**
 * Version 2: the strip holds only tabs that were opened (by the user or a real event), plus
 * at most one "New tab" per tabset. Version 1 re-injected every default tool on each parse.
 */
export interface RightSidebarLayoutState {
  version: 2;
  nextId: number;
  focusedTabsetId: string;
  root: RightSidebarLayoutNode;
}

/**
 * A single tabset. With no requested tool it holds just the "New tab" launcher, which guides
 * the user to the tools instead of showing every tool as an idle tab.
 */
export function getDefaultRightSidebarLayoutState(activeTab?: TabType): RightSidebarLayoutState {
  const tab = activeTab ?? NEW_TAB;
  return {
    version: 2,
    nextId: 2,
    focusedTabsetId: "tabset-1",
    root: {
      type: "tabset",
      id: "tabset-1",
      tabs: [tab],
      activeTab: tab,
    },
  };
}

export function parseRightSidebarLayoutState(
  raw: unknown,
  activeTabFallback?: TabType
): RightSidebarLayoutState {
  // Pre-parse migration: strip removed static tabs from raw data before validation.
  // Must run before isRightSidebarLayoutState since isTabType rejects legacy tabs.
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (r.root && typeof r.root === "object") {
      stripRemovedStaticTabs(r.root as Record<string, unknown>);
    }
  }

  if (!isRightSidebarLayoutState(raw)) {
    return getDefaultRightSidebarLayoutState(activeTabFallback);
  }

  if (raw.version === 1) {
    return {
      ...raw,
      version: 2,
      root: mapTabsets(raw.root, migrateVersion1Tabset),
    };
  }

  // Version 2 is used as-is; only repair invalid tabsets (empty, duplicate New tabs, a stale
  // activeTab). Returns the same object when nothing changed so the persist-back effect in
  // RightSidebar settles instead of rewriting storage on every render.
  const root = mapTabsets(raw.root, normalizeTabset);
  return root === raw.root ? (raw as RightSidebarLayoutState) : { ...raw, version: 2, root };
}

/**
 * Version 1 parsing re-added every default tool (Stats, Review, Instructions, Workflows,
 * Timeline) and the app auto-added Goal/Debug/Desktop/etc., so most static tabs in a v1
 * layout were never opened by the user. Keep what reflects real use: terminals, side chats,
 * and the tab the user was looking at.
 */
function migrateVersion1Tabset(node: TabsetNode): TabsetNode {
  const kept = node.tabs.filter(
    (tab) => isTerminalTab(tab) || getSideChatTabWorkspaceId(tab) != null || tab === node.activeTab
  );
  return normalizeTabset({ ...node, tabs: kept });
}

/** Non-empty tabs, at most one New tab, and an activeTab that is one of the tabs. */
function normalizeTabset(node: TabsetNode): TabsetNode {
  let tabs = node.tabs.filter((tab, index) => !isNewTab(tab) || node.tabs.indexOf(tab) === index);
  if (tabs.length === 0) tabs = [NEW_TAB];
  const activeTab = tabs.includes(node.activeTab) ? node.activeTab : tabs[0];
  if (tabs.length === node.tabs.length && activeTab === node.activeTab) return node;
  return { ...node, tabs, activeTab };
}

function mapTabsets(
  node: RightSidebarLayoutNode,
  fn: (tabset: TabsetNode) => TabsetNode
): RightSidebarLayoutNode {
  if (node.type === "tabset") return fn(node);
  const left = mapTabsets(node.children[0], fn);
  const right = mapTabsets(node.children[1], fn);
  if (left === node.children[0] && right === node.children[1]) return node;
  return { ...node, children: [left, right] };
}

/**
 * Recursively strip removed static tabs from raw layout data.
 * Mutates the object in-place before validation so isTabType doesn't reject the layout.
 */
function stripRemovedStaticTabs(node: Record<string, unknown>): void {
  if (node.type === "tabset") {
    if (Array.isArray(node.tabs)) {
      const isRemovedTab = (tab: unknown) =>
        tab === "stats" ||
        tab === "explorer" ||
        (typeof tab === "string" && tab.startsWith("file:"));
      const filtered = (node.tabs as unknown[]).filter((tab) => !isRemovedTab(tab));
      if (filtered.length !== (node.tabs as unknown[]).length) {
        // A removed-only tabset becomes the New tab, like any other emptied tabset.
        node.tabs = filtered.length > 0 ? filtered : [NEW_TAB];
      }
      if (isRemovedTab(node.activeTab)) {
        node.activeTab = (node.tabs as unknown[]).includes("costs")
          ? "costs"
          : ((node.tabs as unknown[])[0] ?? NEW_TAB);
      }
    }
    return;
  }
  if (node.type === "split" && Array.isArray(node.children)) {
    for (const child of node.children) {
      if (child && typeof child === "object") {
        stripRemovedStaticTabs(child as Record<string, unknown>);
      }
    }
  }
}
export function findTabset(
  root: RightSidebarLayoutNode,
  tabsetId: string
): RightSidebarLayoutNode | null {
  if (root.type === "tabset") {
    return root.id === tabsetId ? root : null;
  }
  return findTabset(root.children[0], tabsetId) ?? findTabset(root.children[1], tabsetId);
}

export function findFirstTabsetId(root: RightSidebarLayoutNode): string | null {
  if (root.type === "tabset") return root.id;
  return findFirstTabsetId(root.children[0]) ?? findFirstTabsetId(root.children[1]);
}

function allocId(state: RightSidebarLayoutState, prefix: "tabset" | "split") {
  const id = `${prefix}-${state.nextId}`;
  return { id, nextId: state.nextId + 1 };
}

function removeTabFromNode(
  node: RightSidebarLayoutNode,
  tab: TabType
): RightSidebarLayoutNode | null {
  if (node.type === "tabset") {
    const oldIndex = node.tabs.indexOf(tab);
    if (oldIndex === -1) return node;

    const tabs = node.tabs.filter((t) => t !== tab);
    if (tabs.length === 0) return null;

    let activeTab = node.activeTab;
    if (node.activeTab === tab) {
      activeTab = tabs[Math.min(oldIndex, tabs.length - 1)];
    }
    return {
      ...node,
      tabs,
      activeTab: tabs.includes(activeTab) ? activeTab : tabs[0],
    };
  }

  const left = removeTabFromNode(node.children[0], tab);
  const right = removeTabFromNode(node.children[1], tab);

  if (!left && !right) {
    return null;
  }

  // If one side goes empty, promote the other side to avoid empty panes.
  if (!left) return right;
  if (!right) return left;
  if (left === node.children[0] && right === node.children[1]) return node;

  return {
    ...node,
    children: [left, right],
  };
}

export function removeTabEverywhere(
  state: RightSidebarLayoutState,
  tab: TabType
): RightSidebarLayoutState {
  const nextRoot = removeTabFromNode(state.root, tab);
  if (nextRoot === state.root) {
    return state;
  }
  if (!nextRoot) {
    // Never an empty strip: closing the last tab leaves the New tab behind.
    return getDefaultRightSidebarLayoutState();
  }

  const focusedExists = findTabset(nextRoot, state.focusedTabsetId) !== null;
  const focusedTabsetId = focusedExists
    ? state.focusedTabsetId
    : (findFirstTabsetId(nextRoot) ?? "tabset-1");

  return {
    ...state,
    root: nextRoot,
    focusedTabsetId,
  };
}
/**
 * Add (or re-select) a tab in a tabset. Opening a tool where the New tab is the only tab, or
 * the one being looked at, replaces it in place: the New tab is a launcher, and leaving it
 * beside the tool it launched would add an idle tab to the strip.
 */
function insertTab(ts: TabsetNode, tab: TabType, activate: boolean): TabsetNode {
  if (ts.tabs.includes(tab)) {
    return activate && ts.activeTab !== tab ? { ...ts, activeTab: tab } : ts;
  }
  const newIndex = ts.tabs.findIndex(isNewTab);
  const replacesNewTab =
    !isNewTab(tab) &&
    newIndex !== -1 &&
    (ts.tabs.length === 1 || (activate && isNewTab(ts.activeTab)));
  if (replacesNewTab) {
    const tabs = ts.tabs.map((t, index) => (index === newIndex ? tab : t));
    return { ...ts, tabs, activeTab: activate || isNewTab(ts.activeTab) ? tab : ts.activeTab };
  }
  return { ...ts, tabs: [...ts.tabs, tab], activeTab: activate ? tab : ts.activeTab };
}

function updateNode(
  node: RightSidebarLayoutNode,
  tabsetId: string,
  updater: (tabset: Extract<RightSidebarLayoutNode, { type: "tabset" }>) => RightSidebarLayoutNode
): RightSidebarLayoutNode {
  if (node.type === "tabset") {
    if (node.id !== tabsetId) return node;
    return updater(node);
  }

  return {
    ...node,
    children: [
      updateNode(node.children[0], tabsetId, updater),
      updateNode(node.children[1], tabsetId, updater),
    ],
  };
}

export function setFocusedTabset(
  state: RightSidebarLayoutState,
  tabsetId: string
): RightSidebarLayoutState {
  if (state.focusedTabsetId === tabsetId) return state;
  return { ...state, focusedTabsetId: tabsetId };
}

export function selectTabInTabset(
  state: RightSidebarLayoutState,
  tabsetId: string,
  tab: TabType
): RightSidebarLayoutState {
  const target = findTabset(state.root, tabsetId);
  if (target?.type !== "tabset") {
    return state;
  }

  if (target.activeTab === tab && target.tabs.includes(tab)) {
    return state;
  }

  return {
    ...state,
    root: updateNode(state.root, tabsetId, (ts) => insertTab(ts, tab, true)),
  };
}

export function reorderTabInTabset(
  state: RightSidebarLayoutState,
  tabsetId: string,
  fromIndex: number,
  toIndex: number
): RightSidebarLayoutState {
  const tabset = findTabset(state.root, tabsetId);
  if (tabset?.type !== "tabset") {
    return state;
  }

  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= tabset.tabs.length ||
    toIndex >= tabset.tabs.length
  ) {
    return state;
  }

  return {
    ...state,
    root: updateNode(state.root, tabsetId, (node) => {
      const nextTabs = [...node.tabs];
      const [moved] = nextTabs.splice(fromIndex, 1);
      if (!moved) {
        return node;
      }

      nextTabs.splice(toIndex, 0, moved);
      return {
        ...node,
        tabs: nextTabs,
      };
    }),
  };
}

export function selectTabInFocusedTabset(
  state: RightSidebarLayoutState,
  tab: TabType
): RightSidebarLayoutState {
  const focused = findTabset(state.root, state.focusedTabsetId);
  if (focused?.type !== "tabset") {
    return state;
  }

  if (focused.activeTab === tab && focused.tabs.includes(tab)) {
    return state;
  }

  return {
    ...state,
    root: updateNode(state.root, focused.id, (ts) => insertTab(ts, tab, true)),
  };
}

export function splitFocusedTabset(
  state: RightSidebarLayoutState,
  direction: "horizontal" | "vertical"
): RightSidebarLayoutState {
  const focused = findTabset(state.root, state.focusedTabsetId);
  if (focused?.type !== "tabset") {
    return state;
  }

  const splitAlloc = allocId(state, "split");
  const tabsetAlloc = allocId({ ...state, nextId: splitAlloc.nextId }, "tabset");

  let left: Extract<RightSidebarLayoutNode, { type: "tabset" }> = focused;
  let right: Extract<RightSidebarLayoutNode, { type: "tabset" }>;
  const newFocusedId = tabsetAlloc.id;

  if (focused.tabs.length > 1) {
    const moved = focused.activeTab;
    const remaining = focused.tabs.filter((t) => t !== moved);
    const oldActive = remaining[0] ?? NEW_TAB;

    left = {
      ...focused,
      tabs: remaining,
      activeTab: oldActive,
    };

    right = {
      type: "tabset",
      id: tabsetAlloc.id,
      tabs: [moved],
      activeTab: moved,
    };
  } else {
    // Avoid empty tabsets: keep the current tabset intact and give the new pane a New tab,
    // so the user picks what it shows.
    right = {
      type: "tabset",
      id: tabsetAlloc.id,
      tabs: [NEW_TAB],
      activeTab: NEW_TAB,
    };
  }

  const splitNode: RightSidebarLayoutNode = {
    type: "split",
    id: splitAlloc.id,
    direction,
    sizes: [50, 50],
    children: [left, right],
  };

  // Replace the focused tabset node in-place.
  const replaceFocused = (node: RightSidebarLayoutNode): RightSidebarLayoutNode => {
    if (node.type === "tabset") {
      return node.id === focused.id ? splitNode : node;
    }

    return {
      ...node,
      children: [replaceFocused(node.children[0]), replaceFocused(node.children[1])],
    };
  };

  return {
    ...state,
    nextId: tabsetAlloc.nextId,
    focusedTabsetId: newFocusedId,
    root: replaceFocused(state.root),
  };
}

export function updateSplitSizes(
  state: RightSidebarLayoutState,
  splitId: string,
  sizes: [number, number]
): RightSidebarLayoutState {
  const update = (node: RightSidebarLayoutNode): RightSidebarLayoutNode => {
    if (node.type === "split") {
      if (node.id === splitId) {
        return { ...node, sizes };
      }
      return {
        ...node,
        children: [update(node.children[0]), update(node.children[1])],
      };
    }
    return node;
  };

  return {
    ...state,
    root: update(state.root),
  };
}

export function collectAllTabs(node: RightSidebarLayoutNode): TabType[] {
  if (node.type === "tabset") return [...node.tabs];
  return [...collectAllTabs(node.children[0]), ...collectAllTabs(node.children[1])];
}
export function hasTab(state: RightSidebarLayoutState, tab: TabType): boolean {
  return collectAllTabs(state.root).includes(tab);
}

export function toggleTab(state: RightSidebarLayoutState, tab: TabType): RightSidebarLayoutState {
  return hasTab(state, tab) ? removeTabEverywhere(state, tab) : selectOrAddTab(state, tab);
}

/**
 * Collect all tabs from all tabsets with their tabset IDs.
 * Returns tabs in layout order (depth-first, left-to-right/top-to-bottom).
 */
export function collectAllTabsWithTabset(
  node: RightSidebarLayoutNode
): Array<{ tab: TabType; tabsetId: string }> {
  if (node.type === "tabset") {
    // New tabs are launchers, not tools: they get no Ctrl/Cmd+number slot and are never the
    // target of select-or-add lookups (a layout may hold one per tabset).
    return node.tabs.filter((tab) => !isNewTab(tab)).map((tab) => ({ tab, tabsetId: node.id }));
  }
  return [
    ...collectAllTabsWithTabset(node.children[0]),
    ...collectAllTabsWithTabset(node.children[1]),
  ];
}

/**
 * Select a tab by its position in the layout (0-indexed).
 * Returns the updated state, or the original state if index is out of bounds.
 */
export function selectTabByIndex(
  state: RightSidebarLayoutState,
  index: number
): RightSidebarLayoutState {
  const allTabs = collectAllTabsWithTabset(state.root);
  if (index < 0 || index >= allTabs.length) {
    return state;
  }
  const { tab, tabsetId } = allTabs[index];
  return selectTabInTabset(setFocusedTabset(state, tabsetId), tabsetId, tab);
}

export function getFocusedActiveTab(state: RightSidebarLayoutState, fallback: TabType): TabType {
  const focused = findTabset(state.root, state.focusedTabsetId);
  if (focused?.type === "tabset") return focused.activeTab;
  return fallback;
}
export function addToolToFocusedTabset(
  state: RightSidebarLayoutState,
  tab: TabType
): RightSidebarLayoutState {
  return selectTabInFocusedTabset(state, tab);
}

/**
 * Add a tab to the focused tabset without changing the active tab.
 * Used for feature-flagged tabs that should be available but not auto-selected.
 */
export function addTabToFocusedTabset(
  state: RightSidebarLayoutState,
  tab: TabType,
  /** Whether to make the new tab active (default: true) */
  activate = true
): RightSidebarLayoutState {
  const focused = findTabset(state.root, state.focusedTabsetId);
  if (focused?.type !== "tabset") {
    return state;
  }

  const next = insertTab(focused, tab, activate);
  if (next === focused) return state;
  return {
    ...state,
    root: updateNode(state.root, focused.id, () => next),
  };
}

/**
 * Select an existing tab anywhere in the layout, or add it to the focused tabset if missing.
 */
export function selectOrAddTab(
  state: RightSidebarLayoutState,
  tab: TabType
): RightSidebarLayoutState {
  const found = collectAllTabsWithTabset(state.root).find((t) => t.tab === tab);
  if (found) {
    return selectTabInTabset(setFocusedTabset(state, found.tabsetId), found.tabsetId, found.tab);
  }

  return addTabToFocusedTabset(state, tab);
}

/** Show the tabset's New tab, adding it (at the end) when the tabset has none. */
export function addNewTabToTabset(
  state: RightSidebarLayoutState,
  tabsetId: string
): RightSidebarLayoutState {
  const target = findTabset(state.root, tabsetId);
  if (target?.type !== "tabset") return state;
  return selectTabInTabset(setFocusedTabset(state, tabsetId), tabsetId, NEW_TAB);
}

/**
 * Open a tool from a tabset's New tab (the launcher). The tool replaces the New tab in place
 * and is selected; a tool already open elsewhere is selected there and the New tab goes away,
 * since a layout holds each tool once.
 */
export function openToolFromNewTab(
  state: RightSidebarLayoutState,
  tabsetId: string,
  tool: TabType
): RightSidebarLayoutState {
  const target = findTabset(state.root, tabsetId);
  if (target?.type !== "tabset" || isNewTab(tool)) return state;

  const existing = collectAllTabsWithTabset(state.root).find((t) => t.tab === tool);
  if (existing) {
    // In another tabset, closing the New tab may collapse its (now pointless) pane.
    const next =
      existing.tabsetId === tabsetId
        ? removeTabFromTabset(state, tabsetId, NEW_TAB)
        : closeTabInTabset(state, tabsetId, NEW_TAB);
    return selectTabInTabset(setFocusedTabset(next, existing.tabsetId), existing.tabsetId, tool);
  }

  const newIndex = target.tabs.findIndex(isNewTab);
  const tabs =
    newIndex === -1
      ? [...target.tabs, tool]
      : target.tabs.map((t, index) => (index === newIndex ? tool : t));
  return {
    ...setFocusedTabset(state, tabsetId),
    root: updateNode(state.root, tabsetId, (ts) => ({ ...ts, tabs, activeTab: tool })),
  };
}

/**
 * Remove a tab from one tabset, keeping the tabset (a lone tab becomes the New tab) instead
 * of collapsing the pane. Used when the New tab hands its place to a tool in the same tabset.
 */
function removeTabFromTabset(
  state: RightSidebarLayoutState,
  tabsetId: string,
  tab: TabType
): RightSidebarLayoutState {
  const target = findTabset(state.root, tabsetId);
  if (target?.type !== "tabset" || !target.tabs.includes(tab)) return state;
  const root = updateNode(state.root, tabsetId, (ts) => {
    const oldIndex = ts.tabs.indexOf(tab);
    const tabs = ts.tabs.filter((t) => t !== tab);
    if (tabs.length === 0) return { ...ts, tabs: [NEW_TAB], activeTab: NEW_TAB };
    const activeTab =
      ts.activeTab === tab ? tabs[Math.min(oldIndex, tabs.length - 1)] : ts.activeTab;
    return { ...ts, tabs, activeTab };
  });
  return { ...state, root };
}

/**
 * Close one tab of one tabset (the strip's X, middle-click, Close Tab shortcut). A tabset left
 * empty collapses into its sibling; when it was the last tabset, the New tab takes its place.
 * Closing the New tab when it is the only tab of the layout does nothing.
 *
 * Scoped to a tabset (unlike removeTabEverywhere) because each tabset may hold its own New tab.
 */
export function closeTabInTabset(
  state: RightSidebarLayoutState,
  tabsetId: string,
  tab: TabType
): RightSidebarLayoutState {
  const target = findTabset(state.root, tabsetId);
  if (target?.type !== "tabset" || !target.tabs.includes(tab)) return state;

  if (target.tabs.length > 1) {
    return removeTabFromTabset(state, tabsetId, tab);
  }

  if (state.root.type === "tabset") {
    // The only pane: leave the New tab (a no-op when that is what is being closed).
    return isNewTab(tab) ? state : getDefaultRightSidebarLayoutState();
  }

  const root = removeTabsetNode(state.root, tabsetId);
  if (root === null) return getDefaultRightSidebarLayoutState();
  const focusedTabsetId =
    findTabset(root, state.focusedTabsetId) !== null
      ? state.focusedTabsetId
      : (findFirstTabsetId(root) ?? "tabset-1");
  return { ...state, root, focusedTabsetId };
}

/** Drop a tabset from the tree, promoting its sibling in place of their split. */
function removeTabsetNode(
  node: RightSidebarLayoutNode,
  tabsetId: string
): RightSidebarLayoutNode | null {
  if (node.type === "tabset") return node.id === tabsetId ? null : node;
  const left = removeTabsetNode(node.children[0], tabsetId);
  const right = removeTabsetNode(node.children[1], tabsetId);
  if (!left) return right;
  if (!right) return left;
  if (left === node.children[0] && right === node.children[1]) return node;
  return { ...node, children: [left, right] };
}

/**
 * Move a tab from one tabset to another.
 * Handles edge cases:
 * - If source tabset becomes empty, it gets removed (along with its parent split if needed)
 * - If target tabset already has the tab, just activates it
 *
 * @returns Updated layout state, or original state if move is invalid
 */
export function moveTabToTabset(
  state: RightSidebarLayoutState,
  tab: TabType,
  sourceTabsetId: string,
  targetTabsetId: string
): RightSidebarLayoutState {
  // No-op if moving to same tabset
  if (sourceTabsetId === targetTabsetId) {
    return selectTabInTabset(state, targetTabsetId, tab);
  }

  const source = findTabset(state.root, sourceTabsetId);
  const target = findTabset(state.root, targetTabsetId);

  if (source?.type !== "tabset" || target?.type !== "tabset") {
    return state;
  }

  // Check if tab exists in source
  if (!source.tabs.includes(tab)) {
    return state;
  }

  // Update the tree: remove from source, add to target
  const updateNode = (node: RightSidebarLayoutNode): RightSidebarLayoutNode | null => {
    if (node.type === "tabset") {
      if (node.id === sourceTabsetId) {
        // Remove tab from source
        const newTabs = node.tabs.filter((t) => t !== tab);
        if (newTabs.length === 0) {
          // Tabset is now empty, signal for removal
          return null;
        }
        const newActiveTab = node.activeTab === tab ? newTabs[0] : node.activeTab;
        return { ...node, tabs: newTabs, activeTab: newActiveTab };
      }
      if (node.id === targetTabsetId) {
        // Add tab to target (avoids duplicates; replaces a lone New tab)
        return insertTab(node, tab, true);
      }
      return node;
    }

    // Split node: recursively update children
    const left = updateNode(node.children[0]);
    const right = updateNode(node.children[1]);

    // Handle case where one child was removed (became null)
    if (left === null && right === null) {
      // Both children empty (shouldn't happen with valid moves)
      return null;
    }
    if (left === null) {
      // Left child removed, promote right
      return right;
    }
    if (right === null) {
      // Right child removed, promote left
      return left;
    }

    return {
      ...node,
      children: [left, right],
    };
  };

  const newRoot = updateNode(state.root);
  if (newRoot === null) {
    // Entire tree collapsed (shouldn't happen)
    return state;
  }

  // Ensure focusedTabsetId is still valid
  let newFocusedId: string = targetTabsetId;
  if (findTabset(newRoot, newFocusedId) === null) {
    newFocusedId = findFirstTabsetId(newRoot) ?? targetTabsetId;
  }

  return {
    ...state,
    focusedTabsetId: newFocusedId,
    root: newRoot,
  };
}

export type TabDockEdge = "left" | "right" | "top" | "bottom";

/**
 * Create a new split adjacent to a target tabset and dock a dragged tab into it.
 *
 * This is the "edge drop" behavior for drag+dock:
 * - drop Left/Right => vertical split
 * - drop Top/Bottom => horizontal split
 *
 * Also handles:
 * - dragging a tab out of its own tabset (source === target)
 * - removing empty source tabsets (collapsing parent splits)
 * - avoiding empty tabsets when a user drags out the last remaining tab
 */
export function dockTabToEdge(
  state: RightSidebarLayoutState,
  tab: TabType,
  sourceTabsetId: string,
  targetTabsetId: string,
  edge: TabDockEdge
): RightSidebarLayoutState {
  const source = findTabset(state.root, sourceTabsetId);
  const target = findTabset(state.root, targetTabsetId);

  if (source?.type !== "tabset" || target?.type !== "tabset") {
    return state;
  }

  if (!source.tabs.includes(tab)) {
    return state;
  }

  const splitDirection: "horizontal" | "vertical" =
    edge === "top" || edge === "bottom" ? "horizontal" : "vertical";
  const insertBefore = edge === "top" || edge === "left";

  const splitAlloc = allocId(state, "split");
  const tabsetAlloc = allocId({ ...state, nextId: splitAlloc.nextId }, "tabset");

  const newTabset: Extract<RightSidebarLayoutNode, { type: "tabset" }> = {
    type: "tabset",
    id: tabsetAlloc.id,
    tabs: [tab],
    activeTab: tab,
  };

  const updateNode = (node: RightSidebarLayoutNode): RightSidebarLayoutNode | null => {
    if (node.type === "tabset") {
      if (node.id === targetTabsetId) {
        let updatedTarget = node;

        // When dragging out of this tabset, remove the tab before splitting.
        if (sourceTabsetId === targetTabsetId) {
          const remaining = node.tabs.filter((t) => t !== tab);
          // Dragging out the last tab leaves a New tab behind instead of an empty pane.
          const nextTabs = remaining.length > 0 ? remaining : [NEW_TAB];
          const nextActiveTab =
            node.activeTab === tab || !nextTabs.includes(node.activeTab)
              ? nextTabs[0]
              : node.activeTab;
          updatedTarget = { ...node, tabs: nextTabs, activeTab: nextActiveTab };
        }

        const children: [RightSidebarLayoutNode, RightSidebarLayoutNode] = insertBefore
          ? [newTabset, updatedTarget]
          : [updatedTarget, newTabset];

        return {
          type: "split",
          id: splitAlloc.id,
          direction: splitDirection,
          sizes: [50, 50],
          children,
        };
      }

      if (node.id === sourceTabsetId) {
        // Remove from source (unless source === target, handled above).
        if (sourceTabsetId === targetTabsetId) {
          return node;
        }

        const remaining = node.tabs.filter((t) => t !== tab);
        if (remaining.length === 0) {
          return null;
        }

        const nextActiveTab = node.activeTab === tab ? remaining[0] : node.activeTab;
        return { ...node, tabs: remaining, activeTab: nextActiveTab };
      }

      return node;
    }

    const left = updateNode(node.children[0]);
    const right = updateNode(node.children[1]);

    if (left === null && right === null) {
      return null;
    }
    if (left === null) {
      return right;
    }
    if (right === null) {
      return left;
    }

    return {
      ...node,
      children: [left, right],
    };
  };

  const newRoot = updateNode(state.root);
  if (newRoot === null) {
    return state;
  }

  const newFocusedId = tabsetAlloc.id;

  return {
    ...state,
    nextId: tabsetAlloc.nextId,
    focusedTabsetId: findTabset(newRoot, newFocusedId) ? newFocusedId : state.focusedTabsetId,
    root: newRoot,
  };
}
