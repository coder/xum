import assert from "@/common/utils/assert";
import {
  normalizeLayoutPresetsConfig,
  type LayoutPreset,
  type LayoutPresetsConfig,
  type LayoutSlotNumber,
  type RightSidebarLayoutPresetNode,
  type RightSidebarLayoutPresetState,
  type RightSidebarPresetTabType,
  type RightSidebarWidthPreset,
} from "@/common/types/uiLayouts";
import type { Keybind } from "@/common/types/keybind";
import {
  getRightSidebarLayoutKey,
  LEFT_SIDEBAR_COLLAPSED_KEY,
  LEFT_SIDEBAR_WIDTH_KEY,
  RIGHT_SIDEBAR_COLLAPSED_KEY,
  RIGHT_SIDEBAR_WIDTH_KEY,
} from "@/common/constants/storage";
import {
  readPersistedState,
  readPersistedString,
  updatePersistedState,
} from "@/browser/hooks/usePersistedState";
import {
  addTabToFocusedTabset,
  collectAllTabs,
  findFirstTabsetId,
  findTabset,
  getDefaultRightSidebarLayoutState,
  type RightSidebarLayoutNode,
  type RightSidebarLayoutState,
} from "@/browser/utils/rightSidebarLayout";
import {
  getRightSidebarTabFallback,
  readRightSidebarLayout,
} from "@/browser/utils/rightSidebarTabFocus";
import { isTabType, makeTerminalTabType, type TabType } from "@/browser/types/rightSidebar";
import { isBaseTabId } from "@/browser/features/RightSidebar/Tabs/tabConfig";
import { createTerminalSession } from "@/browser/utils/terminal";
import type { APIClient } from "@/browser/contexts/API";

export function createLayoutPresetId(): string {
  const maybeCrypto = globalThis.crypto;
  if (maybeCrypto && typeof maybeCrypto.randomUUID === "function") {
    const id = maybeCrypto.randomUUID();
    assert(typeof id === "string" && id.length > 0, "randomUUID() must return a non-empty string");
    return id;
  }

  const id = `layout_preset_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  assert(id.length > 0, "generated id must be non-empty");
  return id;
}

export function getDefaultSlotKeybind(slot: LayoutSlotNumber): Keybind | undefined {
  // Reserve 1–9 for the built-in Ctrl/Cmd+Alt+[1-9] slot hotkeys.
  if (slot >= 1 && slot <= 9) {
    return { key: String(slot), ctrl: true, alt: true };
  }

  return undefined;
}

export function getEffectiveSlotKeybind(
  config: LayoutPresetsConfig,
  slot: LayoutSlotNumber
): Keybind | undefined {
  const override = config.slots.find((s) => s.slot === slot)?.keybindOverride;
  return override ?? getDefaultSlotKeybind(slot);
}

export function getPresetForSlot(
  config: LayoutPresetsConfig,
  slot: LayoutSlotNumber
): LayoutPreset | undefined {
  return config.slots.find((s) => s.slot === slot)?.preset;
}

function clampInt(value: number, min: number, max: number): number {
  const rounded = Math.floor(value);
  return Math.max(min, Math.min(max, rounded));
}

export function resolveRightSidebarWidthPx(width: RightSidebarWidthPreset): number {
  if (width.mode === "px") {
    return clampInt(width.value, 300, 1200);
  }

  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1200;
  return clampInt(viewportWidth * width.value, 300, 1200);
}

function readCurrentRightSidebarCollapsed(): boolean {
  return readPersistedState<boolean>(RIGHT_SIDEBAR_COLLAPSED_KEY, false);
}

function readCurrentRightSidebarWidthPx(): number {
  const raw = readPersistedString(RIGHT_SIDEBAR_WIDTH_KEY);
  if (!raw) return 400;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 400;
  return clampInt(parsed, 300, 1200);
}

function readCurrentLeftSidebarCollapsed(): boolean {
  // Match App.tsx's default: auto-collapse on mobile-ish widths unless the user has an explicit
  // persisted preference yet.
  const defaultCollapsed = typeof window !== "undefined" && window.innerWidth <= 768;
  return readPersistedState<boolean>(LEFT_SIDEBAR_COLLAPSED_KEY, defaultCollapsed);
}

function readCurrentLeftSidebarWidthPx(): number {
  const raw = readPersistedString(LEFT_SIDEBAR_WIDTH_KEY);
  if (!raw) return 288;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 288;
  return clampInt(parsed, 200, 600);
}

function createTerminalPlaceholder(counter: number): RightSidebarPresetTabType {
  const id = `t${counter}`;
  return `terminal_new:${id}`;
}

function toPresetTab(
  tab: TabType,
  ctx: { terminalCounter: number }
): RightSidebarPresetTabType | null {
  if (tab === "terminal" || tab.startsWith("terminal:")) {
    ctx.terminalCounter += 1;
    return createTerminalPlaceholder(ctx.terminalCounter);
  }

  // Tool tabs and the New tab keep their id. Typed so a tab id missing from
  // RIGHT_SIDEBAR_PRESET_BASE_TABS fails to compile instead of being dropped from presets.
  if (isBaseTabId(tab) || tab === "new") {
    const presetTab: RightSidebarPresetTabType = tab;
    return presetTab;
  }

  // Side chats are ephemeral (discarded on restart), so presets leave them out.
  return null;
}

function convertNodeToPreset(
  node: RightSidebarLayoutNode,
  ctx: { terminalCounter: number }
): RightSidebarLayoutPresetNode | null {
  if (node.type === "tabset") {
    const tabs: RightSidebarPresetTabType[] = [];
    let resolvedActiveTab: RightSidebarPresetTabType | null = null;

    for (const tab of node.tabs) {
      const converted = toPresetTab(tab, ctx);
      if (!converted) {
        continue;
      }

      tabs.push(converted);
      if (tab === node.activeTab) {
        resolvedActiveTab = converted;
      }
    }

    if (tabs.length === 0) {
      return null;
    }

    return {
      type: "tabset",
      id: node.id,
      tabs,
      activeTab: resolvedActiveTab ?? tabs[0],
    };
  }

  const left = convertNodeToPreset(node.children[0], ctx);
  const right = convertNodeToPreset(node.children[1], ctx);

  if (!left && !right) {
    return null;
  }
  if (!left) return right;
  if (!right) return left;

  return {
    type: "split",
    id: node.id,
    direction: node.direction,
    sizes: node.sizes,
    children: [left, right],
  };
}

function findPresetTabset(
  root: RightSidebarLayoutPresetNode,
  tabsetId: string
): Extract<RightSidebarLayoutPresetNode, { type: "tabset" }> | null {
  if (root.type === "tabset") {
    return root.id === tabsetId ? root : null;
  }

  return (
    findPresetTabset(root.children[0], tabsetId) ?? findPresetTabset(root.children[1], tabsetId)
  );
}

function findFirstPresetTabsetId(root: RightSidebarLayoutPresetNode): string | null {
  if (root.type === "tabset") return root.id;
  return findFirstPresetTabsetId(root.children[0]) ?? findFirstPresetTabsetId(root.children[1]);
}

function convertLayoutStateToPreset(state: RightSidebarLayoutState): RightSidebarLayoutPresetState {
  const ctx = { terminalCounter: 0 };
  const root = convertNodeToPreset(state.root, ctx);

  if (!root) {
    // Only side chats were open (presets leave them out): save the New tab in their place.
    const fallback = getDefaultRightSidebarLayoutState();
    const fallbackRoot = convertNodeToPreset(fallback.root, { terminalCounter: 0 });
    assert(fallbackRoot !== null, "default right sidebar layout must convert");
    return {
      version: 1,
      nextId: fallback.nextId,
      focusedTabsetId: fallback.focusedTabsetId,
      root: fallbackRoot,
    };
  }

  const focusedTabsetId =
    findPresetTabset(root, state.focusedTabsetId)?.id ??
    findFirstPresetTabsetId(root) ??
    "tabset-1";

  return {
    version: 1,
    nextId: state.nextId,
    focusedTabsetId,
    root,
  };
}

export function createPresetFromCurrentWorkspace(
  workspaceId: string,
  name: string,
  existingPresetId?: string
): LayoutPreset {
  const trimmedName = name.trim();
  assert(trimmedName.length > 0, "preset name must be non-empty");

  const leftSidebarCollapsed = readCurrentLeftSidebarCollapsed();
  const leftSidebarWidthPx = readCurrentLeftSidebarWidthPx();
  const rightSidebarCollapsed = readCurrentRightSidebarCollapsed();
  const rightSidebarWidthPx = readCurrentRightSidebarWidthPx();
  const rightSidebarLayout = readRightSidebarLayout(workspaceId);

  const presetLayout = convertLayoutStateToPreset(rightSidebarLayout);

  const preset: LayoutPreset = {
    id: existingPresetId ?? createLayoutPresetId(),
    name: trimmedName,
    leftSidebarCollapsed,
    leftSidebarWidthPx,
    rightSidebar: {
      collapsed: rightSidebarCollapsed,
      width: { mode: "px", value: rightSidebarWidthPx },
      layout: presetLayout,
    },
  };

  return preset;
}

function collectTerminalTabs(
  root: RightSidebarLayoutPresetNode,
  out: RightSidebarPresetTabType[]
): void {
  if (root.type === "tabset") {
    for (const tab of root.tabs) {
      if (tab.startsWith("terminal_new:")) {
        out.push(tab);
      }
    }
    return;
  }

  collectTerminalTabs(root.children[0], out);
  collectTerminalTabs(root.children[1], out);
}

async function resolveTerminalSessions(
  api: APIClient,
  workspaceId: string,
  terminalTabs: RightSidebarPresetTabType[]
): Promise<Map<RightSidebarPresetTabType, string>> {
  const mapping = new Map<RightSidebarPresetTabType, string>();

  const existing = await api.terminal.listSessions({ workspaceId }).catch(() => []);
  let existingIndex = 0;

  for (const tab of terminalTabs) {
    let sessionId: string | undefined = existing[existingIndex];
    if (sessionId) {
      existingIndex += 1;
    } else {
      try {
        const session = await createTerminalSession(api, workspaceId);
        sessionId = session.sessionId;
      } catch {
        sessionId = undefined;
      }
    }

    if (sessionId) {
      mapping.set(tab, sessionId);
    }
  }

  return mapping;
}

function isTerminalPlaceholderTab(tab: RightSidebarPresetTabType): tab is `terminal_new:${string}` {
  return tab.startsWith("terminal_new:");
}

function resolvePresetTab(
  tab: RightSidebarPresetTabType,
  mapping: Map<RightSidebarPresetTabType, string>
): TabType | null {
  // Migrate legacy "stats" preset tab → "costs" (absorbed as sub-tabs)
  if (tab === "stats") return "costs";

  if (isTerminalPlaceholderTab(tab)) {
    const sessionId = mapping.get(tab);
    return sessionId ? (`terminal:${sessionId}` as const) : null;
  }

  return tab as TabType;
}

function resolvePresetNodeToLayout(
  node: RightSidebarLayoutPresetNode,
  mapping: Map<RightSidebarPresetTabType, string>
): RightSidebarLayoutNode | null {
  if (node.type === "tabset") {
    const tabs = [
      ...new Set(
        node.tabs
          .map((t) => resolvePresetTab(t, mapping))
          .filter((t): t is TabType => !!t && isTabType(t))
      ),
    ];

    if (tabs.length === 0) {
      return null;
    }

    const resolvedActive = resolvePresetTab(node.activeTab, mapping);
    const activeTab = resolvedActive && tabs.includes(resolvedActive) ? resolvedActive : tabs[0];

    return {
      type: "tabset",
      id: node.id,
      tabs,
      activeTab,
    };
  }

  const left = resolvePresetNodeToLayout(node.children[0], mapping);
  const right = resolvePresetNodeToLayout(node.children[1], mapping);

  if (!left && !right) {
    return null;
  }
  if (!left) return right;
  if (!right) return left;

  return {
    type: "split",
    id: node.id,
    direction: node.direction,
    sizes: node.sizes,
    children: [left, right],
  };
}

function resolvePresetLayoutToLayoutState(
  preset: RightSidebarLayoutPresetState,
  mapping: Map<RightSidebarPresetTabType, string>
): RightSidebarLayoutState {
  const root = resolvePresetNodeToLayout(preset.root, mapping);
  if (!root) {
    return getDefaultRightSidebarLayoutState(getRightSidebarTabFallback());
  }

  const focusedTabsetId =
    findTabset(root, preset.focusedTabsetId)?.id ?? findFirstTabsetId(root) ?? "tabset-1";

  return {
    version: 1,
    openTabsOnly: true,
    nextId: preset.nextId,
    focusedTabsetId,
    root,
  };
}

export async function applyLayoutPresetToWorkspace(
  api: APIClient | null,
  workspaceId: string,
  preset: LayoutPreset
): Promise<void> {
  assert(
    typeof workspaceId === "string" && workspaceId.length > 0,
    "workspaceId must be non-empty"
  );

  // Apply global UI keys first so the UI immediately reflects a partially-applied preset
  // even if terminal creation fails.
  updatePersistedState<boolean>(LEFT_SIDEBAR_COLLAPSED_KEY, preset.leftSidebarCollapsed);
  if (preset.leftSidebarWidthPx !== undefined) {
    updatePersistedState<number>(
      LEFT_SIDEBAR_WIDTH_KEY,
      clampInt(preset.leftSidebarWidthPx, 200, 600)
    );
  }
  updatePersistedState<boolean>(RIGHT_SIDEBAR_COLLAPSED_KEY, preset.rightSidebar.collapsed);
  updatePersistedState<number>(
    RIGHT_SIDEBAR_WIDTH_KEY,
    resolveRightSidebarWidthPx(preset.rightSidebar.width)
  );

  if (!api) {
    return;
  }

  const terminalTabs: RightSidebarPresetTabType[] = [];
  collectTerminalTabs(preset.rightSidebar.layout.root, terminalTabs);

  const terminalMapping = await resolveTerminalSessions(api, workspaceId, terminalTabs);

  let layout = resolvePresetLayoutToLayoutState(preset.rightSidebar.layout, terminalMapping);

  // Preserve any extra backend terminal sessions that aren't referenced by the preset.
  // Otherwise those sessions remain running but have no tabs until the workspace is re-mounted.
  const backendSessionIds = await api.terminal.listSessions({ workspaceId }).catch(() => []);

  if (backendSessionIds.length > 0) {
    const currentTabs = collectAllTabs(layout.root);
    const currentTerminalSessionIds = new Set(
      currentTabs.filter((t) => t.startsWith("terminal:")).map((t) => t.slice("terminal:".length))
    );

    for (const sessionId of backendSessionIds) {
      if (currentTerminalSessionIds.has(sessionId)) {
        continue;
      }

      layout = addTabToFocusedTabset(layout, makeTerminalTabType(sessionId), false);
      currentTerminalSessionIds.add(sessionId);
    }
  }

  updatePersistedState<RightSidebarLayoutState>(getRightSidebarLayoutKey(workspaceId), layout);
}

export function updateSlotPreset(
  config: LayoutPresetsConfig,
  slot: LayoutSlotNumber,
  preset: LayoutPreset | undefined
): LayoutPresetsConfig {
  const normalized = normalizeLayoutPresetsConfig(config);
  const existing = normalized.slots.find((s) => s.slot === slot);

  const nextSlots = normalized.slots.filter((s) => s.slot !== slot);

  const keybindOverride = existing?.keybindOverride;
  if (preset || keybindOverride) {
    nextSlots.push({
      slot,
      ...(preset ? { preset } : {}),
      ...(keybindOverride ? { keybindOverride } : {}),
    });
  }

  return {
    ...normalized,
    slots: nextSlots.sort((a, b) => a.slot - b.slot),
  };
}

export function updateSlotKeybindOverride(
  config: LayoutPresetsConfig,
  slot: LayoutSlotNumber,
  keybindOverride: Keybind | undefined
): LayoutPresetsConfig {
  const normalized = normalizeLayoutPresetsConfig(config);
  const existing = normalized.slots.find((s) => s.slot === slot);
  const preset = existing?.preset;

  const nextSlots = normalized.slots.filter((s) => s.slot !== slot);

  if (preset || keybindOverride) {
    nextSlots.push({
      slot,
      ...(preset ? { preset } : {}),
      ...(keybindOverride ? { keybindOverride } : {}),
    });
  }

  return {
    ...normalized,
    slots: nextSlots.sort((a, b) => a.slot - b.slot),
  };
}

export function getLayoutsConfigOrDefault(value: unknown): LayoutPresetsConfig {
  return normalizeLayoutPresetsConfig(value);
}

export function deleteSlotAndShiftFollowingSlots(
  config: LayoutPresetsConfig,
  slot: LayoutSlotNumber
): LayoutPresetsConfig {
  assert(
    Number.isInteger(slot) && slot >= 1,
    "deleteSlotAndShiftFollowingSlots: slot must be a positive integer"
  );

  const normalized = normalizeLayoutPresetsConfig(config);
  const hasSlot = normalized.slots.some((s) => s.slot === slot);
  if (!hasSlot) {
    return normalized;
  }

  const nextSlots = normalized.slots
    .filter((s) => s.slot !== slot)
    .map((s) => {
      if (s.slot > slot) {
        return {
          ...s,
          slot: s.slot - 1,
        };
      }
      return s;
    });

  return normalizeLayoutPresetsConfig({
    ...normalized,
    slots: nextSlots,
  });
}
