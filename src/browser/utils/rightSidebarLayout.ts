import { isTabType, type TabType } from "@/browser/types/rightSidebar";
import { getDefaultLayoutTabIds } from "@/browser/features/RightSidebar/Tabs/tabConfig";

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

export function isRightSidebarLayoutState(value: unknown): value is RightSidebarLayoutState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return false;
  if (typeof v.nextId !== "number") return false;
  if (typeof v.focusedTabsetId !== "string") return false;
  if (!isLayoutNode(v.root)) return false;
  return findTabset(v.root, v.focusedTabsetId) !== null;
}
export interface RightSidebarLayoutState {
  version: 1;
  nextId: number;
  focusedTabsetId: string;
  root: RightSidebarLayoutNode;
}

export function getDefaultRightSidebarLayoutState(activeTab: TabType): RightSidebarLayoutState {
  // Default tabs come from the registry's `inDefaultLayout` flag — no
  // hardcoded list to keep in sync. Adding a tab to the default layout is a
  // one-line metadata change in `Tabs/tabConfig.ts`.
  const defaultTabs: TabType[] = [...getDefaultLayoutTabIds()];
  const tabs = defaultTabs.includes(activeTab) ? defaultTabs : [...defaultTabs, activeTab];

  return {
    version: 1,
    nextId: 2,
    focusedTabsetId: "tabset-1",
    root: {
      type: "tabset",
      id: "tabset-1",
      tabs,
      activeTab,
    },
  };
}

export function parseRightSidebarLayoutState(
  raw: unknown,
  activeTabFallback: TabType
): RightSidebarLayoutState {
  // Pre-parse migration: strip removed static tabs from raw data before validation.
  // Must run before isRightSidebarLayoutState since isTabType rejects legacy tabs.
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (r.root && typeof r.root === "object") {
      stripRemovedStaticTabs(r.root as Record<string, unknown>);
    }
  }

  if (isRightSidebarLayoutState(raw)) {
    // Post-validation migration: auto-add any registry-declared `inDefaultLayout`
    // tabs that the persisted layout is missing. This means newly-introduced
    // default tabs (e.g., the Instructions tab) appear for existing users
    // automatically — no user action, no extra bookkeeping in this module.
    return ensureDefaultLayoutTabs(raw);
  }

  return getDefaultRightSidebarLayoutState(activeTabFallback);
}

/**
 * Ensure every `inDefaultLayout: true` tab from the registry is present in
 * `state`. Missing tabs are appended to the first tabset (the natural
 * upper-left landing spot) without changing the active tab. Already-present
 * tabs are left where the user moved them.
 */
function ensureDefaultLayoutTabs(state: RightSidebarLayoutState): RightSidebarLayoutState {
  const required = getDefaultLayoutTabIds();
  if (required.length === 0) return state;

  const present = new Set<TabType>(collectAllTabs(state.root));
  const missing: TabType[] = required.filter((tab) => !present.has(tab));
  if (missing.length === 0) return state;

  const firstTabsetId = findFirstTabsetId(state.root);
  if (!firstTabsetId) return state;

  const root = appendTabsToTabset(state.root, firstTabsetId, missing);
  return root === state.root ? state : { ...state, root };
}

/** Append tabs to the named tabset, returning a new tree (or the original if unchanged). */
function appendTabsToTabset(
  node: RightSidebarLayoutNode,
  tabsetId: string,
  tabs: TabType[]
): RightSidebarLayoutNode {
  if (node.type === "tabset") {
    if (node.id !== tabsetId) return node;
    return { ...node, tabs: [...node.tabs, ...tabs] };
  }

  const left = appendTabsToTabset(node.children[0], tabsetId, tabs);
  const right = appendTabsToTabset(node.children[1], tabsetId, tabs);
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
        // Ensure at least one tab remains — a removed-only tabset becomes ["costs"].
        node.tabs = filtered.length > 0 ? filtered : ["costs"];
      }
      if (isRemovedTab(node.activeTab)) {
        node.activeTab = (node.tabs as unknown[]).includes("costs")
          ? "costs"
          : ((node.tabs as unknown[])[0] ?? "costs");
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
    return getDefaultRightSidebarLayoutState("costs");
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
    root: updateNode(state.root, tabsetId, (ts) => {
      const tabs = ts.tabs.includes(tab) ? ts.tabs : [...ts.tabs, tab];
      return { ...ts, tabs, activeTab: tab };
    }),
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
    root: updateNode(state.root, focused.id, (ts) => {
      const tabs = ts.tabs.includes(tab) ? ts.tabs : [...ts.tabs, tab];
      return { ...ts, tabs, activeTab: tab };
    }),
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

  const fallbackTab: TabType =
    focused.activeTab === "terminal"
      ? "costs"
      : focused.activeTab === "costs"
        ? "terminal"
        : "terminal";

  let left: Extract<RightSidebarLayoutNode, { type: "tabset" }> = focused;
  let right: Extract<RightSidebarLayoutNode, { type: "tabset" }>;
  const newFocusedId = tabsetAlloc.id;

  if (focused.tabs.length > 1) {
    const moved = focused.activeTab;
    const remaining = focused.tabs.filter((t) => t !== moved);
    const oldActive = remaining[0] ?? "costs";

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
    // Avoid empty tabsets: keep the current tabset intact and spawn a useful default neighbor.
    right = {
      type: "tabset",
      id: tabsetAlloc.id,
      tabs: [fallbackTab],
      activeTab: fallbackTab,
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
    return node.tabs.map((tab) => ({ tab, tabsetId: node.id }));
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

  // Already has the tab - just activate if requested
  if (focused.tabs.includes(tab)) {
    if (activate && focused.activeTab !== tab) {
      return {
        ...state,
        root: updateNode(state.root, focused.id, (ts) => ({
          ...ts,
          activeTab: tab,
        })),
      };
    }
    return state;
  }

  return {
    ...state,
    root: updateNode(state.root, focused.id, (ts) => ({
      ...ts,
      tabs: [...ts.tabs, tab],
      activeTab: activate ? tab : ts.activeTab,
    })),
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
        // Add tab to target (avoid duplicates)
        const newTabs = target.tabs.includes(tab) ? target.tabs : [...target.tabs, tab];
        return { ...node, tabs: newTabs, activeTab: tab };
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

function getFallbackTabForEmptyTabset(movedTab: TabType): TabType {
  return movedTab === "terminal" ? "costs" : movedTab === "costs" ? "terminal" : "terminal";
}

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
          const fallbackTab = getFallbackTabForEmptyTabset(tab);
          const nextTabs = remaining.length > 0 ? remaining : [fallbackTab];
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

