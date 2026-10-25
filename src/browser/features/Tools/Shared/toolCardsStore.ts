import { useSyncExternalStore } from "react";
import assert from "@/common/utils/assert";
import { isDynamicToolPart } from "@/common/types/toolParts";
import type { getToolComponent } from "./getToolComponent";
import type { ProposePlanToolCall } from "../ProposePlanToolCall";
import type { AskUserQuestionChain } from "../AskUserQuestion/AskUserQuestionChain";

// The tool cards (getToolComponent's registry, ~150 KB brotli with markdown-it and framer-motion)
// are off the workspace page's first load (T3, #5971): in the browser a chat without tool calls
// never fetches them. Desktop requests them at idle after the first transcript caught up (#6823, #7004). The lazy chunk (toolCardsLoader) publishes them here, and each tool row re-renders in
// place: rows never suspend, because a Suspense swap replaces every DOM node of its subtree.
// This module has no UI imports, so WorkspaceStore can request the chunk from event code.
export interface ToolCards {
  getToolComponent: typeof getToolComponent;
  ProposePlanToolCall: typeof ProposePlanToolCall;
  AskUserQuestionChain: typeof AskUserQuestionChain;
}

let cards: ToolCards | null = null;
let requested = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const notify = () => {
  for (const listener of listeners) listener();
};

export function publishToolCards(next: ToolCards): void {
  // The chunk evaluates once per page; a second, different registry would be a bundling bug.
  assert(cards === null || cards.getToolComponent === next.getToolComponent, "tool cards differ");
  if (cards !== null) return;
  cards = next;
  notify();
}

/**
 * Starts the cards' chunk download before a tool row mounts (history rows with tool calls, a
 * live stream). Idempotent: only the first call after page load notifies.
 */
export function requestToolCards(): void {
  if (requested || cards !== null) return;
  requested = true;
  notify();
}

/** Requests the cards when one of these history rows holds a tool call. */
export function requestToolCardsForRows(rows: ReadonlyArray<{ parts: readonly unknown[] }>): void {
  if (rows.some((row) => row.parts.some(isDynamicToolPart))) requestToolCards();
}

/** The loaded cards, or null until the lazy chunk has evaluated. */
export function useToolCards(): ToolCards | null {
  return useSyncExternalStore(subscribe, () => cards);
}

/** True once something asked for the cards and they are not loaded yet. */
export function useToolCardsPending(): boolean {
  return useSyncExternalStore(subscribe, () => requested && cards === null);
}
