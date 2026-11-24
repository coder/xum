/**
 * Right-sidebar tab types.
 *
 * Static (non-terminal) tab ids are derived from the lightweight tab config
 * (`@/browser/features/RightSidebar/Tabs/tabConfig`) so type-only consumers do
 * not import panel renderers. This file just lifts those ids to the
 * shared type space so other modules don't have to import the registry just
 * to pattern-match on tab ids.
 */

import { isBaseTabId, type BaseTabType } from "@/browser/features/RightSidebar/Tabs/tabConfig";
export type { BaseTabType };

/**
 * Extended tab type that supports multiple terminal instances.
 * - Terminal tabs: "terminal" (placeholder for new) or "terminal:<sessionId>" for real sessions
 */
export type TabType =
  | BaseTabType
  | `terminal:${string}`
  | "terminal"
  /** A /side chat of this workspace: "side:<sideChatWorkspaceId>". */
  | `side:${string}`
  /** An MCP App view: "app:<viewKey>", the view's mcpAppSelectionKey (one tab per view). */
  | `app:${string}`
  /**
   * The empty "New tab" (Codex-style): a launcher listing the tools a tabset can open. It is
   * not a tool, so it stays out of BaseTabType (palette tool lists, presets, Hide/Show).
   */
  | "new";

/** The "New tab" launcher tab. A tabset holds at most one. */
export const NEW_TAB: TabType = "new";

export function isNewTab(tab: TabType): boolean {
  return tab === NEW_TAB;
}

const SIDE_CHAT_TAB_PREFIX = "side:";
const APP_VIEW_TAB_PREFIX = "app:";

/** Check if a value is a valid tab type (base tab, terminal instance, side chat, or New tab). */
export function isTabType(value: unknown): value is TabType {
  if (typeof value !== "string") return false;
  if (isBaseTabId(value) || value === NEW_TAB) return true;
  if (value.startsWith(SIDE_CHAT_TAB_PREFIX)) return value.length > SIDE_CHAT_TAB_PREFIX.length;
  if (value.startsWith(APP_VIEW_TAB_PREFIX)) return value.length > APP_VIEW_TAB_PREFIX.length;
  return value === "terminal" || value.startsWith("terminal:");
}

/** The side chat workspace a "side:<id>" tab shows, or undefined for other tabs. */
export function getSideChatTabWorkspaceId(tab: TabType): string | undefined {
  return tab.startsWith(SIDE_CHAT_TAB_PREFIX) ? tab.slice(SIDE_CHAT_TAB_PREFIX.length) : undefined;
}

export function makeSideChatTabType(sideChatWorkspaceId: string): TabType {
  return `${SIDE_CHAT_TAB_PREFIX}${sideChatWorkspaceId}`;
}

/** The view key an "app:<viewKey>" tab shows, or undefined for other tabs. */
export function getAppViewTabKey(tab: TabType): string | undefined {
  return tab.startsWith(APP_VIEW_TAB_PREFIX) ? tab.slice(APP_VIEW_TAB_PREFIX.length) : undefined;
}

export function makeAppViewTabType(viewKey: string): TabType {
  return `${APP_VIEW_TAB_PREFIX}${viewKey}`;
}

/** Check if a tab type represents a terminal (either base "terminal" or "terminal:<sessionId>"). */
export function isTerminalTab(tab: TabType): boolean {
  return tab === "terminal" || tab.startsWith("terminal:");
}

/**
 * Get the backend session ID from a terminal tab type.
 * Returns undefined for the placeholder "terminal" tab (new terminal being created).
 */
export function getTerminalSessionId(tab: TabType): string | undefined {
  if (tab === "terminal") return undefined;
  if (tab.startsWith("terminal:")) return tab.slice("terminal:".length);
  return undefined;
}

/** Create a terminal tab type for a given session ID. */
export function makeTerminalTabType(sessionId?: string): TabType {
  return sessionId ? `terminal:${sessionId}` : "terminal";
}

/** Default terminal tab name when no OSC title has been set (0-based index). */
export function getTerminalTabFallbackName(terminalIndex: number): string {
  return terminalIndex === 0 ? "Terminal" : `Terminal ${terminalIndex + 1}`;
}
