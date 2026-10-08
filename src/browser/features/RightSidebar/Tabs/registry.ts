/**
 * Backwards-compat shim for tab display helpers.
 *
 * This file remains so legacy callers can import `getTabContentClassName`,
 * `getTabName`, etc. without pulling in React panel renderers. New non-UI
 * helpers should depend on the lightweight `tabConfig` directly.
 */

import { getSideChatTabWorkspaceId, isNewTab, type TabType } from "@/browser/types/rightSidebar";
import { getTabConfig, isBaseTabId } from "./tabConfig";
import type { ReviewStats as RegistryReviewStats } from "./tabRegistry";

/** Re-exported review stats type (used by RightSidebar wrapper props). */
export type ReviewStats = RegistryReviewStats;

/** Configuration for a terminal tab (still special-cased outside the registry). */
const TERMINAL_TAB_CONTENT_CLASS_NAME = "overflow-hidden p-0";
const TERMINAL_TAB_NAME = "Terminal";

const SIDE_CHAT_TAB_NAME = "Side chat";
const NEW_TAB_NAME = "New tab";
// The New tab launcher scrolls when its tool list is taller than the pane.
const NEW_TAB_CONTENT_CLASS_NAME = "overflow-y-auto p-0";
// The side chat pane lays out its own transcript and composer, like the main chat pane.
const SIDE_CHAT_TAB_CONTENT_CLASS_NAME = "flex flex-col overflow-hidden p-0";

/** Display name for a tab id (incl. terminal, side chat, and New tab). */
export function getTabName(tab: TabType): string {
  if (isBaseTabId(tab)) return getTabConfig(tab).name;
  if (isNewTab(tab)) return NEW_TAB_NAME;
  if (getSideChatTabWorkspaceId(tab) != null) return SIDE_CHAT_TAB_NAME;
  return TERMINAL_TAB_NAME;
}

/** Content container CSS classes for a tab id (incl. terminal, side chat, and New tab). */
export function getTabContentClassName(tab: TabType): string {
  if (isBaseTabId(tab)) return getTabConfig(tab).contentClassName;
  if (isNewTab(tab)) return NEW_TAB_CONTENT_CLASS_NAME;
  if (getSideChatTabWorkspaceId(tab) != null) return SIDE_CHAT_TAB_CONTENT_CLASS_NAME;
  return TERMINAL_TAB_CONTENT_CLASS_NAME;
}
